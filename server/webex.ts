import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { configDir } from "../core/config.ts";
import { providerFetch, faked, FAKE_TOKEN } from "./transport.ts";

/**
 * Webex — spaces, their messages, and posting one back.
 *
 * Auth is daemon-owned like every other provider here, but Webex gives us two
 * doors and both are worth having:
 *
 *   - a PERSONAL ACCESS TOKEN — paste one from developer.webex.com and you are
 *     reading spaces in ten seconds. It expires in 12 hours, which is fine for
 *     a first cut and hopeless for an always-open dash.
 *   - an OAUTH INTEGRATION — client id + secret, a loopback consent flow, and a
 *     refresh token that keeps the daemon signed in. This is the real one.
 *
 * `kona login webex` picks whichever you configured (OAuth if a client id is
 * there, else it prompts for a token) and stores the result in the macOS
 * Keychain — no plaintext credential touches disk.
 *
 *   ~/.config/kona/webex.json   { "client_id": "...", "client_secret": "..." }
 *                               or { "token": "..." } for the token route
 *   env KONA_WEBEX_TOKEN        a token, winning over both (CI, scripts)
 *   macOS Keychain              service `kona-webex` — the refresh token, or a
 *                               pasted personal token
 *
 * READ RECEIPTS: the Webex API has no unread count. What it does give is each
 * room's `lastActivity`, so kona keeps its own high-water mark per space (see
 * `readSeen`) — opening a space marks it read, and anything newer than the mark
 * is unread. That file is the only durable state this applet owns; the messages
 * themselves stay in RAM, like mail.
 */

const CONFIG_FILE = join(configDir(), "webex.json");
export const CONFIG_PATH = CONFIG_FILE;

const KC_SERVICE = "kona-webex";
const KC_REFRESH = "refresh-token";
const KC_TOKEN = "access-token"; // the personal-token route

// Webex checks the redirect URI against the one registered on the integration,
// so it is pinned (same constraint as Spotify, unlike Google's any-port
// loopback). Register exactly this URL when you create the integration.
const PORT = 8898;
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

/** Read spaces + messages, write messages, and resolve display names. */
const SCOPE = ["spark:rooms_read", "spark:messages_read", "spark:messages_write", "spark:people_read"].join(" ");

// Overridable so tests can point at a local fixture server instead of the live
// API (same trick as KONA_TICKER_API / KONA_STATE_DIR).
const apiBase = () => process.env.KONA_WEBEX_API ?? "https://webexapis.com";
const AUTH_URL = () => `${apiBase()}/v1/authorize`;
const TOKEN_URL = () => `${apiBase()}/v1/access_token`;

/**
 * Shown by the applet when there is nothing to authenticate with. Kept to
 * narrow lines — it is read inside a framed terminal panel, not a browser.
 */
export const SETUP_HINT = [
  "Two ways in — both end at  kona login webex",
  "",
  "1. Personal token — quickest, expires in 12h.",
  "   Make one at developer.webex.com and paste it",
  "   when asked.",
  "",
  "2. OAuth integration — stays signed in.",
  "   developer.webex.com/my-apps/new/integration",
  `   redirect  ${REDIRECT_URI}`,
  "   scopes    spark:rooms_read spark:messages_read",
  "             spark:messages_write spark:people_read",
  '   save {"client_id":"…","client_secret":"…"} to',
  `   ${CONFIG_FILE}`,
];

export interface ClientCreds {
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
// Everywhere else there is no `security` binary at all, and spawning a missing
// one THROWS — so every call is guarded. Off macOS the keychain simply holds
// nothing, and KONA_WEBEX_TOKEN / webex.json are the way in.
function kcGet(account: string): string | null {
  try {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", KC_SERVICE, "-a", account, "-w"]);
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}
function kcSet(account: string, secret: string): void {
  let r: { exitCode: number; stderr: Buffer };
  try {
    r = Bun.spawnSync([
      "security", "add-generic-password",
      "-U", // update in place if it exists
      "-s", KC_SERVICE,
      "-a", account,
      "-D", "kona webex credential",
      "-w", secret,
    ]);
  } catch {
    throw new Error(`no keychain here — put the credential in ${CONFIG_FILE} or KONA_WEBEX_TOKEN instead`);
  }
  if (r.exitCode !== 0) throw new Error(`keychain write failed: ${r.stderr.toString()}`);
}
function kcDelete(account: string): void {
  try {
    Bun.spawnSync(["security", "delete-generic-password", "-s", KC_SERVICE, "-a", account]);
  } catch {
    /* nothing to delete without a keychain */
  }
}

/** Forget both credentials — `kona logout webex`. */
export function logout(): void {
  kcDelete(KC_REFRESH);
  kcDelete(KC_TOKEN);
}

/** OAuth client from env or ~/.config/kona/webex.json. */
export async function clientCreds(): Promise<ClientCreds | null> {
  const envId = process.env.KONA_WEBEX_CLIENT_ID;
  const envSecret = process.env.KONA_WEBEX_CLIENT_SECRET;
  if (envId && envSecret) return { client_id: envId, client_secret: envSecret };
  const f = await readJson<Partial<ClientCreds>>(CONFIG_FILE);
  if (f?.client_id && f?.client_secret) return { client_id: f.client_id, client_secret: f.client_secret };
  return null;
}

/** A personal token from env, the keychain, or the config file — in that order. */
export async function personalToken(): Promise<string | null> {
  if (process.env.KONA_WEBEX_TOKEN) return process.env.KONA_WEBEX_TOKEN;
  const kc = kcGet(KC_TOKEN);
  if (kc) return kc;
  const f = await readJson<{ token?: string }>(CONFIG_FILE);
  return f?.token ?? null;
}

/** True when SOMETHING can authenticate a call — refresh token or personal token. */
export async function isAuthed(): Promise<boolean> {
  return kcGet(KC_REFRESH) !== null || (await personalToken()) !== null;
}

/** Save a pasted personal access token to the keychain. */
export function saveToken(token: string): void {
  const t = token.trim();
  if (!t) throw new Error("empty token");
  kcSet(KC_TOKEN, t);
}

/**
 * Sign in. With an OAuth integration configured this runs the loopback consent
 * flow and stores a refresh token; without one it reads a personal access token
 * from stdin. Returns the display name of whoever we ended up as.
 */
export async function login(): Promise<string> {
  const creds = await clientCreds();
  if (!creds) {
    const pasted = await promptForToken();
    saveToken(pasted);
    cached = null;
    return (await me()).displayName;
  }

  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
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

  const authUrl =
    `${AUTH_URL()}?` +
    new URLSearchParams({
      client_id: creds.client_id,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "kona",
    }).toString();

  console.error("Opening your browser to authorize Webex…");
  console.error(`If it doesn't open, visit:\n${authUrl}\n`);
  try {
    Bun.spawn(["open", authUrl]);
  } catch {
    /* the user can copy the URL */
  }

  const code = await codeP;
  await Bun.sleep(400); // let the browser render the success page first
  server.stop(true);

  const res = await providerFetch("webex", TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
  if (!tok.refresh_token || !tok.access_token) {
    throw new Error(`token exchange failed: ${tok.message ?? JSON.stringify(tok)}`);
  }
  kcSet(KC_REFRESH, tok.refresh_token);
  cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 };

  return (await me()).displayName;
}

/** Read a pasted token from the terminal (no echo control — it's a paste). */
async function promptForToken(): Promise<string> {
  console.error("No Webex OAuth integration configured — using a personal access token.");
  console.error("Get one at https://developer.webex.com/docs/getting-started (valid 12h).\n");
  process.stdout.write("token: ");
  for await (const line of console) {
    const t = String(line).trim();
    if (t) return t;
    process.stdout.write("token: ");
  }
  throw new Error("no token entered");
}

// In-memory access token, per daemon lifetime.
let cached: { token: string; exp: number } | null = null;

/** Drop the cached access token — tests, and after a credential change. */
export function resetAuth(): void {
  cached = null;
}

async function accessToken(): Promise<string> {
  if (faked()) return FAKE_TOKEN; // a fake transport authenticates nothing
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;

  const refresh = kcGet(KC_REFRESH);
  const creds = await clientCreds();
  if (refresh && creds) {
    const res = await providerFetch("webex", TOKEN_URL(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: refresh,
      }).toString(),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; message?: string };
    if (!j.access_token) throw new Error(`token refresh failed: ${j.message ?? JSON.stringify(j)}`);
    if (j.refresh_token) kcSet(KC_REFRESH, j.refresh_token); // Webex rotates it
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  // A personal token is used as-is; Webex expires it on its own schedule and
  // there is nothing to refresh, so we don't cache an expiry we can't know.
  const personal = await personalToken();
  if (personal) return personal;

  throw new Error("Not signed in — run `kona login webex`");
}

/**
 * Authenticated Webex API call. Returns null for an empty body (204).
 *
 * Under `bun test` the live API is off limits — `providerFetch` blocks any call
 * that would leave the machine unless a fake is installed or KONA_WEBEX_API
 * points at a fixture server, which by definition isn't live (see #41).
 */
export async function api(path: string, init?: RequestInit): Promise<Record<string, unknown> & any> {
  const token = await accessToken();
  const res = await providerFetch("webex", `${apiBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error("Webex rejected the credential — run `kona login webex`");
  if (res.status === 429) {
    const wait = res.headers.get("retry-after");
    throw new Error(`Webex rate-limited${wait ? ` — retry in ${wait}s` : ""}`);
  }
  if (!res.ok) throw new Error(`webex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- shapes ------------------------------------------------------------------

export interface Space {
  id: string;
  title: string;
  /** "direct" is a 1:1; "group" is a room. */
  kind: "direct" | "group";
  /** Epoch ms of the last message in the space (0 when unknown). */
  lastActivity: number;
  teamId?: string;
}

export interface Message {
  id: string;
  /** Display name when we could resolve one, else the email's local part. */
  from: string;
  personId: string;
  email: string;
  text: string;
  at: number;
  /** Attachments — Webex only gives us their URLs, so we just count them. */
  files: number;
}

export interface OpenSpace {
  space: Space;
  messages: Message[];
}

export interface Me {
  id: string;
  displayName: string;
  email: string;
}

/** An epoch-ms timestamp from Webex's ISO strings; 0 when absent/unparseable. */
export function toMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/** "ada@x.com" -> "ada" — the fallback when a display name isn't resolved. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local || email || "someone";
}

/** Strip the tags off Webex's `html` when a message has no plain `text`. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .trim();
}

/** A message is one row, so collapse newlines into it. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeSpace(raw: unknown): Space | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  return {
    id,
    title: (typeof r.title === "string" && r.title.trim()) || "(untitled space)",
    kind: r.type === "direct" ? "direct" : "group",
    lastActivity: toMs(r.lastActivity) || toMs(r.created),
    ...(typeof r.teamId === "string" ? { teamId: r.teamId } : {}),
  };
}

export function normalizeMessage(raw: unknown, names?: Map<string, string>): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  const email = typeof r.personEmail === "string" ? r.personEmail : "";
  const personId = typeof r.personId === "string" ? r.personId : "";
  const plain = typeof r.text === "string" && r.text ? r.text : "";
  const html = typeof r.html === "string" ? r.html : "";
  const markdown = typeof r.markdown === "string" ? r.markdown : "";
  const files = Array.isArray(r.files) ? r.files.length : 0;
  return {
    id,
    from: names?.get(personId) ?? nameFromEmail(email),
    personId,
    email,
    text: oneLine(plain || stripHtml(html) || markdown) || (files ? `(${files} attachment${files === 1 ? "" : "s"})` : ""),
    at: toMs(r.created),
    files,
  };
}

// --- calls -------------------------------------------------------------------

/** Who the daemon is signed in as. */
export async function me(): Promise<Me> {
  const p = await api("/v1/people/me");
  return {
    id: String(p?.id ?? ""),
    displayName: String(p?.displayName ?? p?.nickName ?? "signed in"),
    email: String((p?.emails as string[] | undefined)?.[0] ?? ""),
  };
}

/** Spaces, most recently active first. */
export async function listSpaces(max = 25): Promise<Space[]> {
  const j = await api(`/v1/rooms?${new URLSearchParams({ sortBy: "lastactivity", max: String(max) })}`);
  const items = (Array.isArray(j?.items) ? j.items : []) as unknown[];
  return items.map((r) => normalizeSpace(r)).filter((s): s is Space => !!s);
}

// personId -> display name. Webex charges a round trip for names it doesn't put
// on the message, so remember them for the daemon's lifetime.
const people = new Map<string, string>();

/** Resolve display names for message authors, batched and cached. */
export async function resolveNames(personIds: string[]): Promise<Map<string, string>> {
  const want = [...new Set(personIds.filter((id) => id && !people.has(id)))];
  // /v1/people takes up to 85 ids per call; one page covers a screen of messages.
  for (let i = 0; i < want.length; i += 80) {
    const batch = want.slice(i, i + 80);
    try {
      const j = await api(`/v1/people?${new URLSearchParams({ id: batch.join(",") })}`);
      for (const p of (Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>) {
        if (typeof p.id === "string" && typeof p.displayName === "string") people.set(p.id, p.displayName);
      }
    } catch {
      // Names are a nicety — a failed lookup just means we fall back to emails.
      break;
    }
  }
  return people;
}

/** A space's recent messages, oldest → newest (Webex returns newest first). */
export async function listMessages(roomId: string, max = 30): Promise<Message[]> {
  const j = await api(`/v1/messages?${new URLSearchParams({ roomId, max: String(max) })}`);
  const items = (Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>;
  const names = await resolveNames(items.map((m) => String(m.personId ?? "")));
  return items
    .map((m) => normalizeMessage(m, names))
    .filter((m): m is Message => !!m)
    .reverse();
}

/** Post a message to a space. The one write this applet does. */
export async function postMessage(roomId: string, text: string): Promise<Message | null> {
  const body = text.trim();
  if (!body) throw new Error("empty message");
  const j = await api("/v1/messages", { method: "POST", body: JSON.stringify({ roomId, text: body }) });
  return normalizeMessage(j, people);
}

// --- read receipts -----------------------------------------------------------

// Webex has no unread count, so kona keeps its own: spaceId -> the lastActivity
// we had seen when the space was last opened. It lives beside the daemon's
// state (not in it) because the applet is ephemeral — messages must not be
// persisted, but "which spaces have I read" must survive a restart.
const seenFile = () =>
  join(process.env.KONA_STATE_DIR ?? join(homedir(), ".local", "state", "kona"), "webex-seen.json");

export type SeenMap = Record<string, number>;

export function readSeen(): SeenMap {
  try {
    const j = JSON.parse(readFileSync(seenFile(), "utf8")) as Record<string, unknown>;
    const out: SeenMap = {};
    for (const [id, at] of Object.entries(j)) {
      const n = toMs(at);
      if (n) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSeen(seen: SeenMap): void {
  const path = seenFile();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(seen, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* a lost read receipt is not worth failing a refresh over */
  }
}

/** Mark a space read up to `at` (defaults to now). Returns the updated map. */
export function markSeen(spaceId: string, at = Date.now()): SeenMap {
  const seen = readSeen();
  if ((seen[spaceId] ?? 0) >= at) return seen;
  seen[spaceId] = at;
  writeSeen(seen);
  return seen;
}

/**
 * A space is unread when it has activity newer than our high-water mark. A
 * space we have never opened counts as unread only if it has any activity at
 * all — otherwise a brand-new sign-in claims every empty space is waiting.
 */
export function isUnread(space: Space, seen: SeenMap): boolean {
  if (!space.lastActivity) return false;
  return space.lastActivity > (seen[space.id] ?? 0);
}

export function unreadCount(spaces: Space[], seen: SeenMap): number {
  return spaces.filter((s) => isUnread(s, seen)).length;
}

/** Compact relative time: "30s", "5m", "3h", "2d". Empty when unknown. */
export function ago(at: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
