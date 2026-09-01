import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { configDir } from "../core/config.ts";

/**
 * Google OAuth for kona — a standard desktop/loopback flow with PKCE. The
 * daemon owns the tokens, so both the TUI and any agent read live Gmail through
 * the same credentials. The user supplies a Desktop OAuth client once (client
 * id + secret); we never ship one.
 *
 * Storage:
 *   ~/.config/kona/google.json   client creds (yours). Accepts either
 *                                {client_id,client_secret} or the raw Google
 *                                download {installed:{...}}.
 *   macOS Keychain               the refresh token — OS-encrypted, gated by
 *                                your login. No plaintext token touches disk.
 */

const CLIENT_FILE = join(configDir(), "google.json");

const KC_SERVICE = "kona-gmail";
const KC_ACCOUNT = "refresh-token";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface ClientCreds {
  client_id: string;
  client_secret: string;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch {
    return null;
  }
}

// --- Keychain (macOS `security`) --------------------------------------------
function kcGet(): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"]);
  if (r.exitCode !== 0) return null;
  const v = r.stdout.toString().trim();
  return v || null;
}
function kcSet(token: string): void {
  const r = Bun.spawnSync([
    "security", "add-generic-password",
    "-U", // update if it already exists
    "-s", KC_SERVICE,
    "-a", KC_ACCOUNT,
    "-D", "kona gmail refresh token",
    "-w", token,
  ]);
  if (r.exitCode !== 0) throw new Error(`keychain write failed: ${r.stderr.toString()}`);
}
export function logout(): void {
  Bun.spawnSync(["security", "delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT]);
}

/** Client creds from env or ~/.config/kona/google.json (raw Google JSON ok). */
export async function clientCreds(): Promise<ClientCreds | null> {
  const envId = process.env.KONA_GOOGLE_CLIENT_ID;
  const envSecret = process.env.KONA_GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) return { client_id: envId, client_secret: envSecret };

  const f = await readJson<Record<string, unknown> & { installed?: ClientCreds; web?: ClientCreds }>(CLIENT_FILE);
  const c = (f?.installed ?? f?.web ?? f) as Partial<ClientCreds> | undefined;
  if (c?.client_id && c?.client_secret) {
    return { client_id: c.client_id, client_secret: c.client_secret };
  }
  return null;
}

export async function isAuthed(): Promise<boolean> {
  return kcGet() !== null;
}

export const CLIENT_CONFIG_PATH = CLIENT_FILE;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Run the interactive login: spin a loopback server, open the consent page,
 * capture the code, exchange for a refresh token, and store it. Returns the
 * signed-in email address.
 */
export async function login(): Promise<string> {
  const creds = await clientCreds();
  if (!creds) {
    throw new Error(
      `No Google client credentials. Create a Desktop OAuth client in Google Cloud Console,\n` +
        `enable the Gmail API, then save it to ${CLIENT_FILE}\n` +
        `(the downloaded JSON works as-is), or set KONA_GOOGLE_CLIENT_ID / KONA_GOOGLE_CLIENT_SECRET.`,
    );
  }

  const { verifier, challenge } = pkce();
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    // Bind IPv4 explicitly: the redirect_uri is http://127.0.0.1, and Bun's
    // default "localhost" can resolve to IPv6 ::1, which 127.0.0.1 can't reach.
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err) {
        rejectCode(new Error(err));
        return new Response("kona: authorization failed. You can close this tab.");
      }
      if (code) {
        resolveCode(code);
        return new Response("kona: authorized ✓  — you can close this tab and return to the terminal.");
      }
      return new Response("kona: waiting for authorization…");
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}`;
  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  console.error("Opening your browser to sign in to Google…");
  console.error(`If it doesn't open, visit:\n${authUrl}\n`);
  try {
    Bun.spawn(["open", authUrl]);
  } catch {
    /* user will copy the URL */
  }

  const code = await codeP;
  // Let the browser receive the success page before we tear the server down.
  await Bun.sleep(400);
  server.stop(true);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  const tok = (await res.json()) as { refresh_token?: string; scope?: string; error?: string };
  if (!tok.refresh_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  }

  kcSet(tok.refresh_token);

  // whoami
  try {
    const profile = await gapi("/gmail/v1/users/me/profile");
    return (profile.emailAddress as string) ?? "signed in";
  } catch {
    return "signed in";
  }
}

// in-memory access-token cache (per daemon lifetime)
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const creds = await clientCreds();
  if (!creds) throw new Error("Gmail not configured — no client credentials");
  const refreshToken = kcGet();
  if (!refreshToken) throw new Error("Not signed in — run `kona login`");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j)}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** Authenticated GET against the Google API host. */
export async function gapi(path: string, params?: Record<string, string>): Promise<Record<string, unknown> & any> {
  const token = await accessToken();
  const url = `https://gmail.googleapis.com${path}` + (params ? `?${new URLSearchParams(params)}` : "");
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${await res.text()}`);
  return res.json();
}
