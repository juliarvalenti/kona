import { join } from "node:path";
import { configDir } from "../core/config.ts";
import { providerFetch, assertAllowed, faked, FAKE_TOKEN } from "./transport.ts";
import { expiringToken, freshToken, pkce, readJson, type AccessToken } from "./provider.ts";
import { callbackPage, type CallbackProvider } from "./callback.ts";

/**
 * Spotify OAuth (Authorization Code + PKCE — no client secret) and a thin Web
 * API layer. The daemon owns the token so the TUI and agents share playback
 * control. You create a Spotify app once and register the redirect URI below.
 *
 *   ~/.config/kona/spotify.json   { "client_id": "..." }  (or env KONA_SPOTIFY_CLIENT_ID)
 *   macOS Keychain                the refresh token (service kona-spotify)
 *
 * Playback CONTROL requires Spotify Premium; reading now-playing does not.
 */

const CONFIG_FILE = join(configDir(), "spotify.json");
const KC_SERVICE = "kona-spotify";
const KC_ACCOUNT = "refresh-token";

// Spotify requires an EXACT redirect URI match (unlike Google's any-port
// loopback), so we pin a port and register this in the app dashboard.
const PORT = 8899;
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private", // your playlists (incl. Discover Weekly / Daily Mixes)
  "user-top-read", // top artists/tracks
  "user-read-recently-played", // recently played
].join(" ");
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

// Point these at a fixture server (or a fake transport) instead of the real
// thing — the same seam KONA_GMAIL_API / KONA_WEBEX_API already give the mail
// and webex tests.
const apiBase = () => process.env.KONA_SPOTIFY_API ?? "https://api.spotify.com";

export async function clientId(): Promise<string | null> {
  if (process.env.KONA_SPOTIFY_CLIENT_ID) return process.env.KONA_SPOTIFY_CLIENT_ID;
  const f = await readJson<{ client_id?: string }>(CONFIG_FILE);
  return f?.client_id ?? null;
}

function kcGet(): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}
function kcSet(token: string): void {
  const r = Bun.spawnSync(["security", "add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-D", "kona spotify refresh token", "-w", token]);
  if (r.exitCode !== 0) throw new Error(`keychain write failed: ${r.stderr.toString()}`);
}
export function logout(): void {
  Bun.spawnSync(["security", "delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT]);
}
export async function isAuthed(): Promise<boolean> {
  if (process.env.KONA_SPOTIFY_TOKEN || faked()) return true; // a fake is "signed in"
  return kcGet() !== null;
}

/** What the browser-facing callback page calls this provider, and how to retry. */
const SPOTIFY: CallbackProvider = { name: "Spotify", login: "spotify" };

export async function login(): Promise<string> {
  const id = await clientId();
  if (!id) {
    throw new Error(
      `No Spotify client id. Create an app at https://developer.spotify.com/dashboard,\n` +
        `add the redirect URI  ${REDIRECT_URI}\n` +
        `then save {"client_id":"..."} to ${CONFIG_FILE} (or set KONA_SPOTIFY_CLIENT_ID).`,
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
    hostname: "127.0.0.1",
    port: PORT,
    fetch(req) {
      const u = new URL(req.url);
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err) {
        rejectCode(new Error(err));
        return callbackPage(SPOTIFY, "failed", err);
      }
      if (code) {
        resolveCode(code);
        return callbackPage(SPOTIFY, "ok");
      }
      return callbackPage(SPOTIFY, "waiting");
    },
  });

  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge_method: "S256",
      code_challenge: challenge,
      show_dialog: "true", // force consent so newly-added scopes are granted
    }).toString();

  console.error("Opening your browser to authorize Spotify…");
  console.error(`If it doesn't open, visit:\n${authUrl}\n`);
  try {
    Bun.spawn(["open", authUrl]);
  } catch {
    /* copy the URL */
  }

  const code = await codeP;
  await Bun.sleep(400);
  server.stop(true);

  const res = await providerFetch("spotify", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: id,
      code_verifier: verifier,
    }).toString(),
  });
  const tok = (await res.json()) as { refresh_token?: string; error_description?: string };
  if (!tok.refresh_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  kcSet(tok.refresh_token);

  try {
    const me = await api("/v1/me");
    return (me?.display_name as string) ?? (me?.id as string) ?? "authorized";
  } catch {
    return "authorized";
  }
}

let cached: AccessToken | null = null;
async function accessToken(): Promise<string> {
  // A fake transport authenticates nothing, so never read the keychain or spend
  // a refresh round-trip under one (KONA_SPOTIFY_TOKEN is the same escape hatch
  // google/microsoft/webex already have).
  if (process.env.KONA_SPOTIFY_TOKEN) return process.env.KONA_SPOTIFY_TOKEN;
  if (faked()) return FAKE_TOKEN;
  const hit = freshToken(cached);
  if (hit) return hit;
  const id = await clientId();
  if (!id) throw new Error("Spotify not configured — no client id");
  const refresh = kcGet();
  if (!refresh) throw new Error("Not signed in — run `kona login spotify`");
  const res = await providerFetch("spotify", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: id }).toString(),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j)}`);
  if (j.refresh_token) kcSet(j.refresh_token); // Spotify may rotate it
  cached = expiringToken(j.access_token, j.expires_in);
  return cached.token;
}

/**
 * Authenticated Web API call. Returns null for 204 (nothing playing).
 *
 * Every call goes through `providerFetch`, so under test a fake answers it from
 * fixtures and records what would have been sent — a `bun test` can never seek,
 * set the volume or transfer playback on a real account (#41).
 */
export async function api(path: string, init?: RequestInit): Promise<Record<string, unknown> & any> {
  const url = `${apiBase()}${path}`;
  // Before the keychain, not after: a blocked call should fail because we are
  // under test, whether or not this machine happens to be signed in.
  assertAllowed("spotify", url, init?.method);
  const token = await accessToken();
  const res = await providerFetch("spotify", url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`spotify ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface QueueItem {
  track: string;
  artist: string;
  uri: string;
}
export interface NowPlaying {
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  device: string;
  deviceId: string; // active device, so the picker can mark it
  volumePct: number; // 0..100 (0 when the device reports none)
  volumeSupported: boolean; // some Connect devices have no volume control
  context: string; // playlist name (or album/artist label)
  contextUri: string; // for navigating into it
  contextType: string; // playlist | album | artist | ""
  artistId: string; // primary artist, for drill-in
  artistName: string;
  upNext: QueueItem[];
  shuffle: boolean;
  repeat: "off" | "context" | "track";
}

// Cache playlist names by uri so we don't refetch every poll.
const contextNames = new Map<string, string>();
async function contextLabel(ctx: any): Promise<string> {
  if (!ctx?.uri || !ctx?.type) return "";
  if (contextNames.has(ctx.uri)) return contextNames.get(ctx.uri)!;
  let label = ctx.type as string;
  try {
    if (ctx.type === "playlist") {
      const pl = await api(`/v1/playlists/${ctx.uri.split(":").pop()}?fields=name`);
      label = pl?.name ?? "playlist";
    } else if (ctx.type === "album") {
      const al = await api(`/v1/albums/${ctx.uri.split(":").pop()}?fields=name`);
      label = al?.name ?? "album";
    }
  } catch {
    /* keep the type label */
  }
  contextNames.set(ctx.uri, label);
  return label;
}

const track = (t: any): QueueItem => ({
  track: t?.name ?? "",
  artist: (t?.artists ?? []).map((a: any) => a.name).join(", "),
  uri: t?.uri ?? "",
});

export async function nowPlaying(): Promise<NowPlaying | null> {
  const p = await api("/v1/me/player");
  if (!p || !p.item) return null;
  const item = p.item as any;
  let upNext: QueueItem[] = [];
  try {
    const q = await api("/v1/me/player/queue");
    upNext = ((q?.queue ?? []) as any[]).slice(0, 8).map(track);
  } catch {
    /* queue unavailable */
  }
  return {
    playing: !!p.is_playing,
    track: item.name ?? "",
    artist: (item.artists ?? []).map((a: any) => a.name).join(", "),
    album: item.album?.name ?? "",
    positionMs: p.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    device: p.device?.name ?? "",
    deviceId: p.device?.id ?? "",
    volumePct: p.device?.volume_percent ?? 0,
    volumeSupported: p.device?.supports_volume !== false,
    context: await contextLabel(p.context),
    contextUri: p.context?.uri ?? "",
    contextType: p.context?.type ?? "",
    artistId: item.artists?.[0]?.id ?? "",
    artistName: item.artists?.[0]?.name ?? "",
    upNext,
    shuffle: !!p.shuffle_state,
    repeat: (p.repeat_state as NowPlaying["repeat"]) ?? "off",
  };
}

export const setShuffle = (on: boolean) =>
  api(`/v1/me/player/shuffle?${new URLSearchParams({ state: String(on) })}`, { method: "PUT" });

export const setRepeat = (state: "off" | "context" | "track") =>
  api(`/v1/me/player/repeat?${new URLSearchParams({ state })}`, { method: "PUT" });

/** Jump to an absolute position in the current track. */
export const seek = (positionMs: number) =>
  api(`/v1/me/player/seek?${new URLSearchParams({ position_ms: String(Math.max(0, Math.round(positionMs))) })}`, {
    method: "PUT",
  });

/** Set the active device's volume (0..100). */
export const setVolume = (pct: number) =>
  api(
    `/v1/me/player/volume?${new URLSearchParams({ volume_percent: String(Math.max(0, Math.min(100, Math.round(pct)))) })}`,
    { method: "PUT" },
  );

export const play = () => api("/v1/me/player/play", { method: "PUT" });
export const pause = () => api("/v1/me/player/pause", { method: "PUT" });
export const next = () => api("/v1/me/player/next", { method: "POST" });
export const previous = () => api("/v1/me/player/previous", { method: "POST" });

/** A browsable item: a track, artist, album, or playlist. */
export interface Row {
  kind: "track" | "artist" | "album" | "playlist";
  id: string;
  uri: string;
  name: string;
  subtitle: string;
  /** For tracks: the album/playlist this track lives in, so playback continues
   * in context (play the album from here) rather than the one track alone. */
  contextUri?: string;
}

const artistsOf = (x: any): string => (x?.artists ?? []).map((a: any) => a.name).join(", ");

/** ISO timestamp -> compact relative age ("3m", "2h", "4d"). */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const trackRow = (t: any): Row => ({ kind: "track", id: t.id, uri: t.uri, name: t.name ?? "", subtitle: artistsOf(t), contextUri: t.album?.uri });

let _market: string | null = null;
async function market(): Promise<string> {
  if (_market) return _market;
  try {
    const me = await api("/v1/me");
    _market = (me?.country as string) ?? "US";
  } catch {
    _market = "US";
  }
  return _market;
}

export interface SearchPage {
  rows: Row[];
  trackOffset: number; // how many track results we've consumed
  trackTotal: number; // total tracks available (for pagination)
}

/** Typed catalog search: artists, then albums, then a first page of tracks. */
export async function search(query: string): Promise<SearchPage> {
  if (!query.trim()) return { rows: [], trackOffset: 0, trackTotal: 0 };
  const r = await api(`/v1/search?${new URLSearchParams({ q: query, type: "artist,album,track,playlist", limit: "6" })}`);
  const artists: Row[] = ((r?.artists?.items ?? []) as any[]).filter(Boolean).slice(0, 3).map((a) => ({
    kind: "artist",
    id: a.id,
    uri: a.uri,
    name: a.name ?? "",
    subtitle: (a.genres ?? []).slice(0, 2).join(", "),
  }));
  const playlists: Row[] = ((r?.playlists?.items ?? []) as any[]).filter(Boolean).slice(0, 4).map((p) => ({
    kind: "playlist",
    id: p.id,
    uri: p.uri,
    name: p.name ?? "",
    subtitle: p.owner?.display_name ?? "playlist",
  }));
  const albums: Row[] = ((r?.albums?.items ?? []) as any[]).filter(Boolean).slice(0, 3).map((a) => ({
    kind: "album",
    id: a.id,
    uri: a.uri,
    name: a.name ?? "",
    subtitle: artistsOf(a),
  }));
  const tracks: Row[] = ((r?.tracks?.items ?? []) as any[]).filter(Boolean).map(trackRow);
  return {
    rows: [...artists, ...playlists, ...albums, ...tracks],
    trackOffset: tracks.length,
    trackTotal: r?.tracks?.total ?? tracks.length,
  };
}

/** Next page of TRACK results (for viewport fill / infinite scroll). */
export async function searchMoreTracks(query: string, offset: number): Promise<{ rows: Row[]; total: number }> {
  const r = await api(`/v1/search?${new URLSearchParams({ q: query, type: "track", limit: "10", offset: String(offset) })}`);
  return { rows: ((r?.tracks?.items ?? []) as any[]).map(trackRow), total: r?.tracks?.total ?? offset };
}

export interface Detail {
  name: string;
  uri: string; // context to play the whole thing
  rows: Row[];
}

export async function artistDetail(id: string): Promise<Detail> {
  const [a, albs] = await Promise.all([
    api(`/v1/artists/${id}`),
    api(`/v1/artists/${id}/albums?${new URLSearchParams({ include_groups: "album,single", limit: "10" })}`),
  ]);
  // top-tracks is 403 for development-mode apps; best-effort, else just albums.
  let topTracks: Row[] = [];
  try {
    const top = await api(`/v1/artists/${id}/top-tracks?market=${await market()}`);
    topTracks = ((top?.tracks ?? []) as any[]).slice(0, 10).map(trackRow);
  } catch {
    /* restricted — fall back to albums only */
  }
  const albums: Row[] = ((albs?.items ?? []) as any[]).map((al) => ({
    kind: "album" as const,
    id: al.id,
    uri: al.uri,
    name: al.name ?? "",
    subtitle: al.release_date?.slice(0, 4) ?? "",
  }));
  return { name: a?.name ?? "Artist", uri: a?.uri ?? "", rows: [...topTracks, ...albums] };
}

export interface HomeSections {
  recents: Row[];
  artists: Row[];
  playlists: Row[];
}

/** Your personal home, in sections: recently played (dated), top artists, and
 * your playlists — the closest thing to Spotify's home the API still gives. */
export async function home(): Promise<HomeSections> {
  // Playlists is the primary section — let its error propagate (e.g. a scope
  // 403) so the applet can show a clear message; the others are best-effort.
  const pls = await api("/v1/me/playlists?limit=50");
  const [tops, recent] = await Promise.all([
    api("/v1/me/top/artists?limit=10").catch(() => null),
    api("/v1/me/player/recently-played?limit=15").catch(() => null),
  ]);
  const playlists: Row[] = ((pls?.items ?? []) as any[]).filter(Boolean).map((p) => ({
    kind: "playlist" as const,
    id: p.id,
    uri: p.uri,
    name: p.name ?? "",
    subtitle: `${p.owner?.display_name ?? ""}`.trim() || "playlist",
  }));
  const artists: Row[] = ((tops?.items ?? []) as any[]).map((a) => ({
    kind: "artist" as const,
    id: a.id,
    uri: a.uri,
    name: a.name ?? "",
    subtitle: "top artist",
  }));
  const seen = new Set<string>();
  const recents: Row[] = ((recent?.items ?? []) as any[])
    .filter((it) => it.track && !seen.has(it.track.id) && (seen.add(it.track.id), true))
    .map((it) => ({ ...trackRow(it.track), subtitle: `${artistsOf(it.track)}  ·  ${ago(it.played_at)}` }));
  return { recents, artists, playlists };
}

export async function playlistDetail(id: string): Promise<Detail> {
  const p = await api(`/v1/playlists/${id}`);
  const rows: Row[] = ((p?.tracks?.items ?? []) as any[])
    .map((it) => it.track)
    .filter(Boolean)
    .map(trackRow);
  return { name: p?.name ?? "Playlist", uri: p?.uri ?? "", rows };
}

export async function albumDetail(id: string): Promise<Detail> {
  const al = await api(`/v1/albums/${id}`);
  const rows: Row[] = ((al?.tracks?.items ?? []) as any[]).map((t) => ({
    kind: "track" as const,
    id: t.id,
    uri: t.uri,
    name: t.name ?? "",
    subtitle: artistsOf(t),
    contextUri: al.uri, // album tracklist items carry no album; set it here
  }));
  return { name: al?.name ?? "Album", uri: al?.uri ?? "", rows };
}

/** Start playback of specific track URIs on the active device. */
export const playUris = (uris: string[]) =>
  api("/v1/me/player/play", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uris }),
  });

/** Play a track within its context (album/playlist), so playback continues. */
export const playInContext = (context_uri: string, trackUri: string) =>
  api("/v1/me/player/play", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context_uri, offset: { uri: trackUri } }),
  });

/** Queue a track after the current one — playback keeps going. */
export const queueUri = (uri: string) =>
  api(`/v1/me/player/queue?${new URLSearchParams({ uri })}`, { method: "POST" });

/**
 * The first track matching free text — how an AGENT names a song ("rave green
 * four tet") when it has no uri to hand.
 */
export async function findTrack(query: string): Promise<Row | null> {
  if (!query.trim()) return null;
  const r = await api(`/v1/search?${new URLSearchParams({ q: query, type: "track", limit: "1" })}`);
  const t = ((r?.tracks?.items ?? []) as any[]).filter(Boolean)[0];
  return t ? trackRow(t) : null;
}

/** Play a whole context (artist / album / playlist uri). */
export const playContext = (context_uri: string) =>
  api("/v1/me/player/play", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context_uri }),
  });

/** A Spotify Connect device you can hand playback to. */
export interface Device {
  id: string;
  name: string;
  type: string; // Computer | Smartphone | Speaker | ...
  active: boolean;
  volumePct: number;
  supportsVolume: boolean;
}

/** Every device this account can currently reach (Connect targets). */
export async function devices(): Promise<Device[]> {
  const r = await api("/v1/me/player/devices");
  return ((r?.devices ?? []) as any[])
    .filter((d) => d?.id) // restricted devices come back without an id
    .map((d) => ({
      id: d.id as string,
      name: (d.name as string) ?? "",
      type: (d.type as string) ?? "",
      active: !!d.is_active,
      volumePct: d.volume_percent ?? 0,
      supportsVolume: d.supports_volume !== false,
    }));
}

/** Move playback to another device. `play` keeps the current play/pause state. */
export const transferPlayback = (deviceId: string, play = true) =>
  api("/v1/me/player", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
