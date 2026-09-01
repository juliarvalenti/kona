import { defineApplet, text, spacer, col, row, theme, appletAccent, type ViewNode } from "../../sdk/index.ts";
import { progress, divider, recordRow } from "../../sdk/components.ts";
import {
  nowPlaying,
  play,
  pause,
  next,
  previous,
  setShuffle,
  setRepeat,
  playInContext,
  search,
  searchMoreTracks,
  artistDetail,
  albumDetail,
  home as fetchHome,
  playUris,
  playContext,
  seek as seekTo,
  setVolume,
  devices as fetchDevices,
  transferPlayback,
  queueUri,
  findTrack,
  type QueueItem,
  type Row,
} from "../../server/spotify.ts";

/**
 * spotify — now-playing + transport control. The daemon holds the OAuth token
 * and drives the Spotify Web API, so YOU control playback with the keyboard and
 * an AGENT can call the same verbs ("skip this", "pause", "turn it down",
 * "move it to the kitchen speaker"). Reading now-playing works on any account;
 * play/pause/next/prev, seek, volume and device transfer all require Premium
 * plus an active device.
 */

interface SpotifyState {
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  device: string;
  deviceId: string;
  volumePct: number;
  volumeSupported: boolean;
  context: string;
  contextUri: string;
  contextType: string;
  artistId: string;
  artistName: string;
  upNext: QueueItem[];
  shuffle: boolean;
  repeat: "off" | "context" | "track";
  authed: boolean;
  loading: boolean;
  error: string | null;
  nowCursor: number; // cursor over the now-playing screen's selectable rows
  // search / browse: a stack of screens; the top is the current one.
  mode: "now" | "browse";
  query: string;
  stack: Screen[];
}

/** Selectable rows on the now-playing screen: the artist, the context
 * (playlist/album), and each up-next track. */
type NowTarget =
  | { kind: "artist"; id: string; name: string }
  | { kind: "context"; uri: string; ctype: string; name: string }
  | { kind: "track"; uri: string; name: string };

function nowTargets(s: SpotifyState): NowTarget[] {
  const t: NowTarget[] = [];
  if (s.artistId) t.push({ kind: "artist", id: s.artistId, name: s.artistName });
  if (s.contextUri && ["playlist", "album", "artist"].includes(s.contextType)) {
    t.push({ kind: "context", uri: s.contextUri, ctype: s.contextType, name: s.context });
  }
  for (const q of s.upNext) if (q.uri) t.push({ kind: "track", uri: q.uri, name: q.track });
  return t;
}

/** A selectable row: catalog Row plus a synthetic "play this whole thing"
 * action, a section header, and a Connect device (the device picker screen). */
type BrowseRow =
  | Row
  | { kind: "play"; uri: string; name: string; subtitle: string }
  | { kind: "header"; name: string }
  | { kind: "device"; id: string; name: string; subtitle: string; active: boolean };
interface Screen {
  title: string;
  rows: BrowseRow[];
  cursor: number;
  /** Present on search screens: track pagination cursor for viewport fill. */
  more?: { query: string; offset: number; total: number };
}

/**
 * Spotify keeps its brand green as its default accent; `[applets.spotify]
 * accent = "#..."` in ~/.config/kona/config.toml overrides it. The rest are
 * theme roles, so a palette change carries through.
 */
const BRAND = "#1db954"; // Spotify green
const palette = () => {
  const t = theme();
  return { GREEN: appletAccent("spotify", BRAND), FG: t.fg, AMBER: t.warn, DIM: t.dim };
};

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

async function loadNow(state: SpotifyState, emit: () => void) {
  try {
    const np = await nowPlaying();
    if (np) {
      Object.assign(state, np);
    } else {
      state.track = "";
      state.playing = false;
      state.context = "";
      state.upNext = [];
    }
    state.authed = true;
    state.error = null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.error = msg;
    if (/signed in|not configured|client id/i.test(msg)) state.authed = false;
  } finally {
    emit();
  }
}

let ticks = 0;

/** Push an artist/album detail screen (Play action + its rows) and switch to browse. */
async function pushDetail(state: SpotifyState, emit: () => void, kind: "artist" | "album", id: string) {
  state.mode = "browse";
  state.loading = true;
  emit();
  try {
    const d = kind === "artist" ? await artistDetail(id) : await albumDetail(id);
    state.stack.push({
      title: d.name,
      rows: [{ kind: "play", uri: d.uri, name: `Play ${d.name}`, subtitle: "" }, ...d.rows],
      cursor: 0,
    });
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

const idOf = (uri: string) => uri.split(":").pop() ?? "";

/** Title of the device-picker screen; also how we spot it on the stack. */
const DEVICES_TITLE = "Devices";

/** How far ←/→ scrub, and how much +/- move the volume. */
const SEEK_STEP_MS = 10_000;
const VOLUME_STEP = 5;

export default defineApplet<SpotifyState>({
  id: "spotify",
  title: "Spotify",
  summary: "Now playing + transport control.",
  icon: "♫",
  tint: BRAND,
  labels: ["music", "network"],
  requires: ["a Spotify account: `kona login spotify`"],
  auth: { spotify: () => import("../../server/spotify.ts") },
  configSample: `[applets.spotify]
accent = "#1db954"   # Spotify green`,
  ephemeral: true,
  initialState: {
    playing: false,
    track: "",
    artist: "",
    album: "",
    positionMs: 0,
    durationMs: 0,
    device: "",
    deviceId: "",
    volumePct: 0,
    volumeSupported: true,
    context: "",
    contextUri: "",
    contextType: "",
    artistId: "",
    artistName: "",
    upNext: [],
    shuffle: false,
    repeat: "off",
    authed: false,
    loading: false,
    error: null,
    nowCursor: 0,
    mode: "now",
    query: "",
    stack: [],
  },

  docs: {
    refresh: "Re-read now-playing, the queue, and the active device. Call this before you read state.",
    playPause: "Toggle playback.",
    next: "Skip to the next track.",
    previous: "Back to the previous track.",
    shuffle: "Toggle shuffle.",
    repeat: "Cycle repeat: off -> context -> track.",
    seek: { doc: "Scrub. Agents pass an absolute `positionMs`; the arrow keys pass `deltaMs`.", args: { positionMs: 90000 } },
    volume: { doc: "Set the volume (`pct`) or nudge it (`delta`), 0-100.", args: { pct: 40 } },
    queue: {
      doc: "Queue a track to play after the current one — by `uri`, or by free-text `q` we resolve to the first match.",
      args: { q: "four tet rave green" },
    },
    devices: "List Spotify Connect devices (and open the picker for the human).",
    transfer: { doc: "Hand playback to another device, by `id` or by `name`.", args: { name: "kitchen" } },
    search: { doc: "Search the catalog — artists, albums, playlists, tracks.", args: { q: "four tet" } },
    more: "Append the next page of track results.",
    home: "Load recently played, top artists and your playlists.",
    enter: { doc: "Act on a row of the current screen: play a track, open an artist/album, pick a device.", args: { index: 0 } },
  },

  recipes: [
    {
      title: "Queue a track without stopping what is playing",
      steps: [
        `kona call spotify queue '{"q":"four tet rave green"}'   # -> { queued: true, track: "..." }`,
        `kona state spotify                                       # upNext now leads with it`,
      ],
      note: "Needs `kona login spotify` and an active device (`kona call spotify devices`). To play something *now* instead, `spotify.search` then `spotify.enter {\"index\":N}`.",
    },
  ],

  verbs: {
    async refresh(_a, { state, emit }) {
      await loadNow(state, emit);
      return { track: state.track, playing: state.playing };
    },
    async playPause(_a, { state, emit }) {
      state.playing = !state.playing; // optimistic
      emit();
      try {
        await (state.playing ? play() : pause());
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(300);
      await loadNow(state, emit);
    },
    async next(_a, { state, emit }) {
      try {
        await next();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(400);
      await loadNow(state, emit);
    },
    async previous(_a, { state, emit }) {
      try {
        await previous();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(400);
      await loadNow(state, emit);
    },
    async shuffle(_a, { state, emit }) {
      state.shuffle = !state.shuffle; // optimistic
      emit();
      try {
        await setShuffle(state.shuffle);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(300);
      await loadNow(state, emit);
      return { shuffle: state.shuffle };
    },
    async repeat(_a, { state, emit }) {
      const nextOf = { off: "context", context: "track", track: "off" } as const; // cycle
      state.repeat = nextOf[state.repeat]; // optimistic
      emit();
      try {
        await setRepeat(state.repeat);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(300);
      await loadNow(state, emit);
      return { repeat: state.repeat };
    },
    // Scrub. Agents pass an absolute {positionMs}; the ←/→ keys pass {deltaMs}.
    // Optimistic so the bar moves under your finger, then loadNow reconciles.
    async seek(args, { state, emit }) {
      if (!state.track) return {};
      const base = args.positionMs !== undefined ? Number(args.positionMs) : state.positionMs + Number(args.deltaMs ?? 0);
      const max = state.durationMs > 0 ? state.durationMs : base;
      const pos = Math.max(0, Math.min(max, Math.round(base)));
      state.positionMs = pos; // optimistic
      emit();
      try {
        await seekTo(pos);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(400); // the player reports the new position a beat later
      await loadNow(state, emit);
      return { positionMs: state.positionMs };
    },
    // Volume. {pct} sets an absolute level, {delta} nudges (the +/- keys).
    async volume(args, { state, emit }) {
      if (!state.volumeSupported) {
        state.error = `${state.device || "this device"} has no volume control`;
        emit();
        return { volumePct: state.volumePct };
      }
      const base = args.pct !== undefined ? Number(args.pct) : state.volumePct + Number(args.delta ?? 0);
      const pct = Math.max(0, Math.min(100, Math.round(base)));
      state.volumePct = pct; // optimistic
      emit();
      try {
        await setVolume(pct);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(300);
      await loadNow(state, emit);
      return { volumePct: state.volumePct };
    },
    /**
     * Queue a track to play after the current one. An AGENT names it in words
     * (`{"q":"four tet rave green"}`) and we resolve the first match; YOU press
     * `q` on a track row in browse and the same verb queues the selection.
     */
    async queue(args, { state, emit }) {
      const scr = state.stack[state.stack.length - 1];
      const rowUnderCursor = state.mode === "browse" ? scr?.rows[scr.cursor] : undefined;
      const uri =
        (typeof args.uri === "string" && args.uri) ||
        (rowUnderCursor?.kind === "track" ? rowUnderCursor.uri : "");
      const q = String(args.q ?? args.query ?? args.track ?? "");
      if (!uri && !q) {
        state.error = "queue needs a uri, a q, or a track under the cursor";
        emit();
        return { queued: false, error: state.error };
      }
      try {
        let target = uri;
        let name = rowUnderCursor?.kind === "track" && !args.uri ? rowUnderCursor.name : "";
        if (!target) {
          const found = await findTrack(q);
          if (!found) throw new Error(`no track matching "${q}"`);
          target = found.uri;
          name = [found.name, found.subtitle].filter(Boolean).join(" — ");
        }
        await queueUri(target);
        state.error = null;
        await Bun.sleep(300); // the queue reports the new tail a beat later
        await loadNow(state, emit);
        return { queued: true, uri: target, track: name };
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        emit();
        return { queued: false, error: state.error };
      }
    },
    // Open the device picker: a browse screen of Connect targets. Selecting one
    // transfers playback (see enter). Re-opening refreshes it in place rather
    // than stacking another copy.
    async devices(_a, { state, emit }) {
      state.mode = "browse";
      state.loading = true;
      const top = state.stack[state.stack.length - 1];
      if (top?.title !== DEVICES_TITLE) state.stack.push({ title: DEVICES_TITLE, rows: [], cursor: 0 });
      emit();
      let found: { id: string; name: string; active: boolean }[] = [];
      try {
        const ds = await fetchDevices();
        found = ds.map((d) => ({ id: d.id, name: d.name, active: d.active }));
        const scr = state.stack[state.stack.length - 1]!;
        scr.rows = ds.map((d) => ({
          kind: "device" as const,
          id: d.id,
          name: d.name,
          subtitle: [d.type, d.supportsVolume ? `${d.volumePct}%` : ""].filter(Boolean).join("  ·  "),
          active: d.active,
        }));
        scr.cursor = Math.max(0, ds.findIndex((d) => d.active));
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { devices: found };
    },
    // Hand playback to another device, by id or (for agents) by name.
    async transfer(args, { state, emit }) {
      const id = String(args.id ?? "");
      const name = String(args.name ?? "").toLowerCase();
      try {
        let target = id;
        if (!target && name) {
          const ds = await fetchDevices();
          target = ds.find((d) => d.name.toLowerCase().includes(name))?.id ?? "";
          if (!target) throw new Error(`no device matching "${args.name}"`);
        }
        if (!target) throw new Error("transfer needs an id or a name");
        await transferPlayback(target, state.playing);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        emit();
        return { device: state.device };
      }
      await Bun.sleep(600); // Connect handoff takes a beat to report
      await loadNow(state, emit);
      return { device: state.device };
    },
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.mode = "browse";
      state.stack = [{ title: `search: ${state.query}`, rows: [], cursor: 0 }];
      state.loading = true;
      emit();
      try {
        const page = await search(state.query);
        const scr = state.stack[0]!;
        scr.rows = page.rows;
        scr.more = { query: state.query, offset: page.trackOffset, total: page.trackTotal };
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { query: state.query, count: state.stack[0]?.rows.length ?? 0 };
    },
    // Append the next page of track results (viewport fill / infinite scroll).
    async more(_a, { state, emit }) {
      const scr = state.stack[state.stack.length - 1];
      if (!scr?.more || scr.more.offset >= scr.more.total || state.loading) return;
      state.loading = true;
      emit();
      try {
        const { rows, total } = await searchMoreTracks(scr.more.query, scr.more.offset);
        scr.rows.push(...rows);
        scr.more.total = total;
        scr.more.offset += rows.length || total; // no rows -> stop
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
    },
    async home(_a, { state, emit }) {
      state.mode = "browse";
      state.stack = [{ title: "Home", rows: [], cursor: 0 }];
      state.loading = true;
      emit();
      try {
        const h = await fetchHome();
        const rows: BrowseRow[] = [];
        // Recently played FIRST (it's the dated stuff you care about), then
        // top artists, then playlists — with section headers.
        if (h.recents.length) rows.push({ kind: "header", name: "Recently played" }, ...h.recents);
        if (h.artists.length) rows.push({ kind: "header", name: "Top artists" }, ...h.artists);
        if (h.playlists.length) rows.push({ kind: "header", name: "Your playlists" }, ...h.playlists);
        const first = rows.findIndex((r) => r.kind !== "header");
        state.stack[0] = { title: "Home", rows, cursor: first < 0 ? 0 : first };
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
    },
    // enter: acts on the selection. On the now-playing screen the cursor moves
    // over artist / context / up-next; in browse it's the current screen's rows.
    // An index (a mouse click on a row, or an agent's call) selects first, in
    // whichever cursor space the current screen uses.
    async enter(a, { state, emit }) {
      try {
        if (typeof a.index === "number") {
          if (state.mode === "now") {
            state.nowCursor = Math.max(0, Math.min(nowTargets(state).length - 1, a.index));
          } else {
            const scr = state.stack[state.stack.length - 1];
            if (scr) scr.cursor = Math.max(0, Math.min(scr.rows.length - 1, a.index));
          }
          emit();
        }
        if (state.mode === "now") {
          const t = nowTargets(state)[state.nowCursor];
          if (!t) return {};
          if (t.kind === "artist") await pushDetail(state, emit, "artist", t.id);
          else if (t.kind === "track") {
            // up-next lives in the current context — resume it there so playback continues
            if (state.contextUri) await playInContext(state.contextUri, t.uri);
            else await playUris([t.uri]);
            await Bun.sleep(400);
            await loadNow(state, emit);
          } else if (t.kind === "context") {
            if (t.ctype === "album") await pushDetail(state, emit, "album", idOf(t.uri));
            else if (t.ctype === "artist") await pushDetail(state, emit, "artist", idOf(t.uri));
            else {
              await playContext(t.uri); // playlist: can't browse (403), so play it
              await Bun.sleep(400);
              await loadNow(state, emit);
            }
          }
          return {};
        }

        // browse mode
        const scr = state.stack[state.stack.length - 1];
        const r = scr?.rows[scr.cursor];
        if (!r || r.kind === "header") return {};
        if (r.kind === "device") {
          await transferPlayback(r.id, state.playing);
          state.stack.pop(); // close the picker, back where you came from
          if (state.stack.length === 0) state.mode = "now";
          emit();
          await Bun.sleep(600); // Connect handoff takes a beat to report
          await loadNow(state, emit);
          return { device: r.name };
        }
        if (r.kind === "track") {
          // play in the track's album/playlist context so it continues
          if (r.contextUri) await playInContext(r.contextUri, r.uri);
          else await playUris([r.uri]);
          state.mode = "now";
          await Bun.sleep(400);
          await loadNow(state, emit);
          return { playing: r.name };
        }
        if (r.kind === "play" || r.kind === "playlist") {
          await playContext(r.uri);
          state.mode = "now";
          await Bun.sleep(400);
          await loadNow(state, emit);
          return { playing: r.name };
        }
        await pushDetail(state, emit, r.kind === "artist" ? "artist" : "album", r.id);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        emit();
      }
      return {};
    },
    back(_a, { state, emit }) {
      state.stack.pop();
      if (state.stack.length === 0) state.mode = "now";
      emit();
    },
    up(_a, { state, emit }) {
      if (state.mode === "now") {
        state.nowCursor = Math.max(0, state.nowCursor - 1);
        return emit();
      }
      const scr = state.stack[state.stack.length - 1];
      if (!scr) return emit();
      let i = scr.cursor - 1;
      while (i >= 0 && scr.rows[i]?.kind === "header") i--; // skip section headers
      if (i >= 0) scr.cursor = i;
      emit();
    },
    down(_a, { state, emit }) {
      if (state.mode === "now") {
        state.nowCursor = Math.min(Math.max(0, nowTargets(state).length - 1), state.nowCursor + 1);
        return emit();
      }
      const scr = state.stack[state.stack.length - 1];
      if (!scr) return emit();
      let i = scr.cursor + 1;
      while (i < scr.rows.length && scr.rows[i]?.kind === "header") i++;
      if (i < scr.rows.length) scr.cursor = i;
      emit();
    },
  },

  init({ state, emit }) {
    void loadNow(state, emit);
  },

  // Advance the progress bar locally each second; reconcile with the API every
  // ~4s (and always while paused stays cheap).
  tickMs: 1000,
  tick({ state, emit }) {
    ticks++;
    if (state.playing && state.durationMs > 0) {
      state.positionMs = Math.min(state.durationMs, state.positionMs + 1000);
    }
    if (ticks % 4 === 0) void loadNow(state, emit);
    else emit();
  },

  // Declaration order is hint-bar priority: the footer keeps two lines and
  // drops from the tail, so transport comes before the browse extras.
  keymap: {
    space: { verb: "playPause", label: "play/pause" },
    // ←/→ scrub, but only on now-playing — in a list they stay navigation
    // (back / open), which is what `when` guards.
    left: { verb: "seek", args: { deltaMs: -SEEK_STEP_MS }, label: "seek", when: (s) => s.mode === "now" },
    right: { verb: "seek", args: { deltaMs: SEEK_STEP_MS }, label: "seek", when: (s) => s.mode === "now" },
    "+": { verb: "volume", args: { delta: VOLUME_STEP }, label: "vol" },
    "-": { verb: "volume", args: { delta: -VOLUME_STEP }, label: "vol" },
    n: { verb: "next", label: "next" },
    p: { verb: "previous", label: "prev" },
    d: { verb: "devices", label: "devices" },
    s: { verb: "shuffle", label: "shuffle" },
    r: { verb: "repeat", label: "repeat" },
    b: { verb: "home", label: "home" },
    // `q` queues the highlighted track — the keyboard half of `spotify.queue`.
    q: { verb: "queue", label: "queue", when: (s) => s.mode === "browse" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "enter",
    selectLabel: "open/play",
    back: "back",
    backLabel: "back",
    canBack: (s) => s.mode === "browse",
  },

  search: { verb: "search", placeholder: "search spotify (artists, albums, tracks)…" },

  // Fill the viewport with more track results on a search screen (else the box
  // sits mostly empty). Only search screens paginate; detail screens are bounded.
  paginate: {
    more: "more",
    count: (s) => (s.mode === "browse" ? (s.stack[s.stack.length - 1]?.rows.length ?? 999) : 999),
    hasMore: (s) => {
      const m = s.stack[s.stack.length - 1]?.more;
      return !!m && m.offset < m.total;
    },
    atEnd: (s) => {
      const scr = s.stack[s.stack.length - 1];
      return scr ? scr.cursor >= scr.rows.length - 1 : false;
    },
  },

  crumb: (s) => (s.mode === "browse" ? (s.stack[s.stack.length - 1]?.title ?? null) : null),

  accent(state) {
    const { GREEN, AMBER, DIM } = palette();
    if (state.error && !state.authed) return AMBER;
    return state.playing ? GREEN : DIM;
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const { GREEN, FG, AMBER, DIM } = palette();

    if (!state.authed && !state.loading) {
      return [
        col([
          text("Not signed in to Spotify", { color: AMBER }),
          spacer(),
          text("Run  kona login spotify  to connect.", { dim: true }),
        ], { align: "center", justify: "center", grow: true }),
      ];
    }

    // Browse (search results / artist / album), a stack of screens.
    if (state.mode === "browse") {
      const scr = state.stack[state.stack.length - 1];
      const head = state.loading ? text("loading…", { color: AMBER }) : text(scr?.title ?? "", { dim: true });
      const tag = (r: BrowseRow) => {
        if (r.kind === "play") return "▶";
        if (r.kind === "device") return r.active ? "● active" : "device";
        return r.kind === "track" || r.kind === "header" ? "" : r.kind;
      };
      const rows: ViewNode[] = (scr?.rows ?? []).map((r, i) => {
        if (r.kind === "header") return text(r.name.toUpperCase(), { color: GREEN });
        return recordRow(
          [
            { text: r.name, grow: true },
            { text: "subtitle" in r ? r.subtitle : "", width: Math.min(28, Math.floor(W * 0.3)) },
            { text: tag(r), width: 9, align: "right" },
          ],
          {
            width: W,
            selected: i === (scr?.cursor ?? -1),
            accent: GREEN,
            color: r.kind === "play" || (r.kind === "device" && r.active) ? GREEN : FG,
            index: i,
          },
        );
      });
      if (!rows.length && !state.loading) {
        rows.push(
          state.error
            ? text(/scope/i.test(state.error) ? "missing access — run: kona login spotify" : truncate(state.error, W - 4), { color: AMBER })
            : text("no matches", { dim: true }),
        );
      }
      return [col([head, divider(W - 1), ...rows])];
    }

    if (!state.track) {
      return [
        col([
          text("Nothing playing", { color: DIM }),
          spacer(),
          text("Start playback on any Spotify device, then press r.", { dim: true }),
        ], { align: "center", justify: "center", grow: true }),
      ];
    }

    const barW = Math.min(48, W - 16);
    const frac = state.durationMs > 0 ? state.positionMs / state.durationMs : 0;
    const color = state.playing ? GREEN : FG;
    const subW = Math.min(28, Math.floor(W * 0.3));

    // The now-playing screen is navigable: artist / context / up-next are
    // selectable. `ti` tracks the target index as we lay them out so highlights
    // line up with nowCursor (see nowTargets()).
    const cur = Math.min(state.nowCursor, Math.max(0, nowTargets(state).length - 1));
    let ti = 0;
    const nodes: ViewNode[] = [text(`${state.playing ? "▶" : "⏸"} ${state.track}`, { color })];

    if (state.artistId) {
      const i = ti++;
      nodes.push(recordRow([{ text: `by ${state.artistName}`, grow: true }, { text: "artist", width: 8, align: "right" }], { width: W, selected: cur === i, accent: GREEN, color: FG, index: i }));
    } else {
      nodes.push(text(`by ${state.artist}`, { dim: true }));
    }

    nodes.push(text(state.album, { dim: true }));
    if (state.contextUri && ["playlist", "album", "artist"].includes(state.contextType)) {
      const i = ti++;
      nodes.push(recordRow([{ text: `from ${state.context}`, grow: true }, { text: state.contextType, width: 8, align: "right" }], { width: W, selected: cur === i, accent: GREEN, color: FG, index: i }));
    }

    nodes.push(
      spacer(),
      row([text(fmt(state.positionMs), { dim: true }), progress(frac, { width: barW, color: GREEN }), text(fmt(state.durationMs), { dim: true })], { align: "center", gap: 1 }),
      spacer(),
      row(
        [
          text(
            `${state.device ? `♪ ${state.device}` : ""}${state.device && state.volumeSupported ? `  ·  vol ${state.volumePct}%` : ""}`,
            { dim: true },
          ),
          text(state.shuffle ? "   ⤮ shuffle" : "", { color: GREEN }),
          text(state.repeat === "context" ? "   ⟳ all" : state.repeat === "track" ? "   ⟳ one" : "", { color: GREEN }),
        ],
        { align: "center" },
      ),
    );

    if (state.upNext.length) {
      nodes.push(spacer(), divider(W - 1), text("up next", { dim: true }));
      for (const q of state.upNext) {
        const i = ti++;
        nodes.push(
          recordRow([{ text: q.track, grow: true }, { text: q.artist, width: subW, align: "right" }], { width: W, selected: cur === i, accent: GREEN, color: FG, index: i }),
        );
      }
    }

    return [col(nodes)];
  },
});
