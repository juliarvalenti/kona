import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { configDir } from "../core/config.ts";
import { kcGet, kcSet, kcDelete } from "./keychain.ts";
import { addAccount, kcAccountName, kcService, listAccounts, removeAccount, LEGACY_ACCOUNT } from "./mail.ts";
import { providerFetch, faked, FAKE_TOKEN } from "./transport.ts";

/**
 * Google OAuth for kona — a standard desktop/loopback flow with PKCE. The
 * daemon owns the tokens, so both the TUI and any agent read AND write live
 * Gmail through the same credentials. The user supplies a Desktop OAuth client
 * once (client id + secret); we never ship one.
 *
 * Tokens are per mailbox: `kona login gmail` twice connects two accounts, each
 * keyed in the keychain by its own address (see server/mail.ts). A token stored
 * by an older kona under the fixed name "refresh-token" keeps working as the
 * account `default`.
 *
 * Storage:
 *   ~/.config/kona/google.json   client creds (yours). Accepts either
 *                                {client_id,client_secret} or the raw Google
 *                                download {installed:{...}}.
 *   macOS Keychain               the refresh token — OS-encrypted, gated by
 *                                your login. No plaintext token touches disk.
 */

const CLIENT_FILE = join(configDir(), "google.json");

const SERVICE = kcService("gmail");

/**
 * Read AND write: kona is a mail client, not a mail viewer. `gmail.modify`
 * covers reading, the unread flag, archiving, trashing and labels;
 * `gmail.compose`/`gmail.send` cover drafts and sending. A token minted by an
 * older, read-only kona keeps reading fine — the first write it refuses tells
 * you to run `kona login gmail` again (see isScopeError in server/mail.ts).
 */
const SCOPE = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

/** The Gmail API host; an env override lets tests drive a fixture server. */
const apiBase = () => process.env.KONA_GMAIL_API ?? "https://gmail.googleapis.com";

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

function refreshTokenFor(account: string): string | null {
  return kcGet(SERVICE, kcAccountName(account));
}

/** Forget one mailbox, or every Gmail account when called without one. */
export async function logout(account?: string): Promise<void> {
  const targets = account
    ? [account]
    : [LEGACY_ACCOUNT, ...listAccounts().filter((a) => a.provider === "gmail").map((a) => a.id)];
  for (const id of targets) {
    kcDelete(SERVICE, kcAccountName(id));
    await removeAccount("gmail", id);
  }
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

export async function isAuthed(account = LEGACY_ACCOUNT): Promise<boolean> {
  return refreshTokenFor(account) !== null;
}

export const CLIENT_CONFIG_PATH = CLIENT_FILE;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Ask Gmail who a freshly minted access token belongs to. */
async function whoami(accessToken: string): Promise<string | null> {
  try {
    const res = await providerFetch("gmail", `${apiBase()}/gmail/v1/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const profile = (await res.json()) as { emailAddress?: string };
    return profile.emailAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the interactive login: spin a loopback server, open the consent page,
 * capture the code, exchange for a refresh token, and store it under the
 * address it belongs to. Returns the signed-in email address.
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
      // `select_account` lets you pick WHICH mailbox to add — the point of
      // multi-account; `consent` still forces a fresh refresh token.
      prompt: "select_account consent",
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

  const res = await providerFetch("gmail", TOKEN_URL, {
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
  const tok = (await res.json()) as { refresh_token?: string; access_token?: string; error?: string };
  if (!tok.refresh_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  }

  // Name the account before storing it: the address is the keychain key.
  const address = (tok.access_token ? await whoami(tok.access_token) : null) ?? LEGACY_ACCOUNT;
  kcSet(SERVICE, kcAccountName(address), tok.refresh_token, "kona gmail refresh token");
  if (address !== LEGACY_ACCOUNT) await addAccount("gmail", address);
  return address === LEGACY_ACCOUNT ? "signed in" : address;
}

// in-memory access-token cache, per account (per daemon lifetime)
const cached = new Map<string, { token: string; exp: number }>();

async function accessToken(account: string): Promise<string> {
  // A token straight from the environment (tests, scripts against a fixture).
  if (process.env.KONA_GOOGLE_TOKEN) return process.env.KONA_GOOGLE_TOKEN;
  if (faked()) return FAKE_TOKEN; // a fake transport authenticates nothing
  const hit = cached.get(account);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const creds = await clientCreds();
  if (!creds) throw new Error("Gmail not configured — no client credentials");
  const refreshToken = refreshTokenFor(account);
  if (!refreshToken) throw new Error("Not signed in — run `kona login`");

  const res = await providerFetch("gmail", TOKEN_URL, {
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
  cached.set(account, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** Authenticated GET against the Google API host, as one connected mailbox. */
export async function gapi(
  account: string,
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown> & any> {
  const token = await accessToken(account);
  const url = `${apiBase()}${path}` + (params ? `?${new URLSearchParams(params)}` : "");
  const res = await providerFetch("gmail", url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * The same, for the calls that change something: send, modify labels, drafts.
 * A body is sent as JSON; an empty 204 answers as `{}` so callers can await it
 * without checking for a payload.
 */
export async function gapiWrite(
  account: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<Record<string, unknown> & any> {
  const token = await accessToken(account);
  const url = `${apiBase()}${path}` + (params ? `?${new URLSearchParams(params)}` : "");
  const res = await providerFetch("gmail", url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${await res.text()}`);
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}
