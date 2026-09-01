import { join } from "node:path";
import { configDir } from "../core/config.ts";
import { kcGet, kcSet, kcDelete } from "./keychain.ts";
import { addAccount, kcAccountName, kcService, listAccounts, removeAccount } from "./mail.ts";
import { providerFetch, faked, FAKE_TOKEN } from "./transport.ts";
import { expiringToken, freshToken, pkce, readJson, type AccessToken } from "./provider.ts";

/**
 * Microsoft identity platform OAuth for kona — auth code + PKCE against a
 * PUBLIC client (no secret to keep), the `common` tenant so personal
 * outlook.com and work/school accounts both work, and a loopback redirect the
 * daemon owns, exactly like server/google.ts. Tokens are per mailbox, so
 * `kona login outlook` twice connects two Outlook accounts.
 *
 * Storage:
 *   ~/.config/kona/microsoft.json  { "client_id": "...", "tenant": "common" }
 *                                  (or env KONA_MICROSOFT_CLIENT_ID / _TENANT)
 *   macOS Keychain                 the refresh token (service kona-outlook,
 *                                  account = the mailbox address)
 */

const CONFIG_FILE = join(configDir(), "microsoft.json");
const SERVICE = kcService("outlook");

// Azure matches redirect URIs exactly, so the port is pinned rather than
// ephemeral (Google's any-port loopback is the exception, not the rule) —
// register this URI on the app's "Mobile and desktop applications" platform.
// KONA_MICROSOFT_PORT moves it when 8897 is taken.
const DEFAULT_PORT = 8897;
export function redirectPort(): number {
  const raw = Number(process.env.KONA_MICROSOFT_PORT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PORT;
}
// IPv4 literal, not "localhost": Bun's default hostname can resolve to ::1 and
// the browser then lands on a port nothing is listening on (the gotcha that bit
// Gmail and Spotify).
export function redirectUri(): string {
  return `http://127.0.0.1:${redirectPort()}/callback`;
}

// Mail.ReadWrite covers reading, the isRead flag, moving to Archive/Deleted
// Items, categories and drafts; Mail.Send is the separate permission Graph
// insists on for actually sending. offline_access buys the refresh token,
// User.Read names the mailbox we just connected.
const SCOPE = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"].join(" ");

export const GRAPH = "https://graph.microsoft.com/v1.0";

/** The Graph host; an env override lets tests drive a fixture server. */
export const graphBase = () => process.env.KONA_GRAPH_API ?? GRAPH;

function tenant(): string {
  return process.env.KONA_MICROSOFT_TENANT || cachedTenant || "common";
}
let cachedTenant: string | null = null;

const authUrlFor = (t: string) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`;
const tokenUrlFor = (t: string) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;

/** App registration (Application/client id) from env or microsoft.json. */
export async function clientId(): Promise<string | null> {
  if (process.env.KONA_MICROSOFT_CLIENT_ID) return process.env.KONA_MICROSOFT_CLIENT_ID;
  const f = await readJson<{ client_id?: string; tenant?: string; appId?: string }>(CONFIG_FILE);
  if (f?.tenant) cachedTenant = f.tenant;
  return f?.client_id ?? f?.appId ?? null;
}

export const CLIENT_CONFIG_PATH = CONFIG_FILE;

export async function isAuthed(account: string): Promise<boolean> {
  return kcGet(SERVICE, kcAccountName(account)) !== null;
}

/** Forget one mailbox, or every Outlook account when called without one. */
export async function logout(account?: string): Promise<void> {
  const targets = account ? [account] : listAccounts().filter((a) => a.provider === "outlook").map((a) => a.id);
  for (const id of targets) {
    kcDelete(SERVICE, kcAccountName(id));
    await removeAccount("outlook", id);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Ask Graph which mailbox a fresh access token belongs to. */
async function whoami(accessToken: string): Promise<string | null> {
  try {
    const res = await providerFetch("outlook", `${graphBase()}/me?$select=mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const me = (await res.json()) as { mail?: string; userPrincipalName?: string };
    return me.mail || me.userPrincipalName || null;
  } catch {
    return null;
  }
}

/**
 * Interactive login: spin the loopback server, open the consent page, capture
 * the code, exchange it, then store the refresh token under the address it
 * belongs to. Returns that address.
 */
export async function login(): Promise<string> {
  const id = await clientId();
  if (!id) {
    throw new Error(
      `No Microsoft client id. Register an app at https://portal.azure.com (App registrations),\n` +
        `add the redirect URI  ${redirectUri()}  under "Mobile and desktop applications",\n` +
        `grant the delegated Microsoft Graph permissions Mail.ReadWrite + Mail.Send +\n` +
        `offline_access + User.Read,\n` +
        `then save {"client_id":"..."} to ${CONFIG_FILE} (or set KONA_MICROSOFT_CLIENT_ID).`,
    );
  }

  const { verifier, challenge } = pkce();
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: redirectPort(),
      fetch(req) {
        const u = new URL(req.url);
        const err = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        if (err) {
          rejectCode(new Error(`${err}: ${u.searchParams.get("error_description") ?? ""}`));
          return new Response("kona: authorization failed. You can close this tab.");
        }
        if (code) {
          resolveCode(code);
          return new Response("kona: authorized ✓  — you can close this tab and return to the terminal.");
        }
        return new Response("kona: waiting for authorization…");
      },
    });
  } catch (e) {
    throw new Error(
      `can't listen on ${redirectUri()} (${e instanceof Error ? e.message : String(e)}).\n` +
        `Free the port, or set KONA_MICROSOFT_PORT and register the matching redirect URI.`,
    );
  }

  const url =
    `${authUrlFor(tenant())}?` +
    new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: redirectUri(),
      response_mode: "query",
      scope: SCOPE,
      // Always let the user choose which mailbox to connect — this flow runs
      // once per account, not once per install.
      prompt: "select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  console.error("Opening your browser to sign in to Microsoft…");
  console.error(`If it doesn't open, visit:\n${url}\n`);
  try {
    Bun.spawn(["open", url]);
  } catch {
    /* user will copy the URL */
  }

  const code = await codeP;
  await Bun.sleep(400); // let the browser get the success page first
  server.stop(true);

  const res = await providerFetch("outlook", tokenUrlFor(tenant()), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      code,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
      code_verifier: verifier,
      scope: SCOPE,
    }).toString(),
  });
  const tok = (await res.json()) as TokenResponse;
  if (!tok.refresh_token || !tok.access_token) {
    throw new Error(`token exchange failed: ${tok.error_description ?? JSON.stringify(tok)}`);
  }

  const address = await whoami(tok.access_token);
  if (!address) throw new Error("signed in, but Graph would not say which mailbox — is User.Read granted?");
  kcSet(SERVICE, kcAccountName(address), tok.refresh_token, "kona outlook refresh token");
  cached.set(address, expiringToken(tok.access_token, tok.expires_in));
  await addAccount("outlook", address);
  return address;
}

// in-memory access-token cache, per account (per daemon lifetime)
const cached = new Map<string, AccessToken>();

async function accessToken(account: string): Promise<string> {
  // A token straight from the environment (tests, scripts against a fixture).
  if (process.env.KONA_MICROSOFT_TOKEN) return process.env.KONA_MICROSOFT_TOKEN;
  if (faked()) return FAKE_TOKEN; // a fake transport authenticates nothing
  const hit = freshToken(cached.get(account));
  if (hit) return hit;
  const id = await clientId();
  if (!id) throw new Error("Outlook not configured — no client id");
  const refreshToken = kcGet(SERVICE, kcAccountName(account));
  if (!refreshToken) throw new Error("Not signed in — run `kona login outlook`");

  const res = await providerFetch("outlook", tokenUrlFor(tenant()), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPE,
    }).toString(),
  });
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error(`token refresh failed: ${j.error_description ?? JSON.stringify(j)}`);
  // Microsoft rotates refresh tokens: the old one dies, so persist the new one
  // or the next daemon start is signed out.
  if (j.refresh_token && j.refresh_token !== refreshToken) {
    try {
      kcSet(SERVICE, kcAccountName(account), j.refresh_token, "kona outlook refresh token");
    } catch {
      /* keep going on this access token; we just re-auth sooner */
    }
  }
  cached.set(account, expiringToken(j.access_token, j.expires_in));
  return j.access_token;
}

/**
 * Authenticated GET against Microsoft Graph as one connected mailbox. `path` is
 * either a v1.0-relative path ("/me/messages") or an absolute Graph URL, which
 * is what an `@odata.nextLink` hands back for the next page.
 */
export async function graph(
  account: string,
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown> & any> {
  const token = await accessToken(account);
  const base = path.startsWith("http") ? path : `${graphBase()}${path}`;
  const url = params ? `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(params)}` : base;
  const res = await providerFetch("outlook", url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`graph ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * The same, for the calls that change something: send, reply, move, patch. Most
 * Graph mail actions answer 202/204 with no body, so an empty response comes
 * back as `{}` rather than blowing up in JSON.parse.
 */
export async function graphWrite(
  account: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> & any> {
  const token = await accessToken(account);
  const url = path.startsWith("http") ? path : `${graphBase()}${path}`;
  const res = await providerFetch("outlook", url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`graph ${res.status}: ${await res.text()}`);
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}
