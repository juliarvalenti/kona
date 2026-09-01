import { defineApplet, text, spacer, col, row, type ViewNode } from "../../sdk/index.ts";
import { progress, divider, recordRow } from "../../sdk/components.ts";
import {
  nowPlaying,
  play,
  pause,
  next,
  previous,
  search,
  searchMoreTracks,
  artistDetail,
  albumDetail,
  playlistDetail,
  home as fetchHome,
  playUris,
  playContext,
  type QueueItem,
  type Row,
} from "../../server/spotify.ts";

/**
 * spotify — now-playing + transport control. The daemon holds the OAuth token
 * and drives the Spotify Web API, so YOU control playback with the keyboard and
 * an AGENT can call the same verbs ("skip this", "pause"). Reading now-playing
 * works on any account; play/pause/next/prev require Premium + an active device.
 */

interface SpotifyState {
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  device: string;
  context: string;
  upNext: QueueItem[];
  authed: boolean;
  loading: boolean;
  error: string | null;
  // search / browse: a stack of screens; the top is the current one.
  mode: "now" | "browse";
  query: string;
  stack: Screen[];
}

/** A selectable row: catalog Row plus a synthetic "play this whole thing" action. */
type BrowseRow = Row | { kind: "play"; uri: string; name: string; subtitle: string };
interface Screen {
  title: string;
  rows: BrowseRow[];
  cursor: number;
  /** Present on search screens: track pagination cursor for viewport fill. */
  more?: { query: string; offset: number; total: number };
}

const GREEN = "#1db954"; // Spotify green
const FG = "#d0d0d0";
const AMBER = "#f0b000";
const DIM = "#6a6a6a";

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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

export default defineApplet<SpotifyState>({
  id: "spotify",
  title: "Spotify",
  summary: "Now playing + transport control.",
  ephemeral: true,
  initialState: {
    playing: false,
    track: "",
    artist: "",
    album: "",
    positionMs: 0,
    durationMs: 0,
    device: "",
    context: "",
    upNext: [],
    authed: false,
    loading: false,
    error: null,
    mode: "now",
    query: "",
    stack: [],
  },

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
        state.stack[0]!.rows = await fetchHome();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
    },
    // enter: play a track / play-a-context, or drill into an artist/album/playlist.
    async enter(_a, { state, emit }) {
      const scr = state.stack[state.stack.length - 1];
      const r = scr?.rows[scr.cursor];
      if (!r) return {};
      try {
        if (r.kind === "track") {
          await playUris([r.uri]);
          state.mode = "now";
          await Bun.sleep(400);
          await loadNow(state, emit);
          return { playing: r.name };
        }
        if (r.kind === "play") {
          await playContext(r.uri);
          state.mode = "now";
          await Bun.sleep(400);
          await loadNow(state, emit);
          return { playing: r.name };
        }
        // artist / album / playlist -> push a detail screen with a Play action.
        state.loading = true;
        emit();
        const d =
          r.kind === "artist"
            ? await artistDetail(r.id)
            : r.kind === "playlist"
              ? await playlistDetail(r.id)
              : await albumDetail(r.id);
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
      return { screen: state.stack[state.stack.length - 1]?.title };
    },
    back(_a, { state, emit }) {
      state.stack.pop();
      if (state.stack.length === 0) state.mode = "now";
      emit();
    },
    up(_a, { state, emit }) {
      const scr = state.stack[state.stack.length - 1];
      if (scr) scr.cursor = Math.max(0, scr.cursor - 1);
      emit();
    },
    down(_a, { state, emit }) {
      const scr = state.stack[state.stack.length - 1];
      if (scr) scr.cursor = Math.min(scr.rows.length - 1, scr.cursor + 1);
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

  keymap: {
    space: { verb: "playPause", label: "play/pause" },
    n: { verb: "next", label: "next" },
    p: { verb: "previous", label: "prev" },
    b: { verb: "home", label: "home" },
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
    if (state.error && !state.authed) return AMBER;
    return state.playing ? GREEN : DIM;
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);

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
      const tag = (k: BrowseRow["kind"]) =>
        k === "play" ? "▶" : k === "artist" ? "artist" : k === "album" ? "album" : k === "playlist" ? "playlist" : "";
      const rows: ViewNode[] = (scr?.rows ?? []).map((r, i) =>
        recordRow(
          [
            { text: r.kind === "play" ? r.name : r.name, grow: true },
            { text: r.subtitle, width: Math.min(28, Math.floor(W * 0.3)) },
            { text: tag(r.kind), width: 9, align: "right" },
          ],
          {
            width: W,
            selected: i === (scr?.cursor ?? -1),
            accent: GREEN,
            color: r.kind === "play" ? GREEN : FG,
          },
        ),
      );
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

    const nodes: ViewNode[] = [
      text(state.track, { color }),
      text(state.artist, { dim: true }),
      text(`${state.playing ? "▶" : "⏸"} ${state.album}${state.context ? `  ·  from ${state.context}` : ""}`, { dim: true }),
      spacer(),
      row([text(fmt(state.positionMs), { dim: true }), progress(frac, { width: barW, color: GREEN }), text(fmt(state.durationMs), { dim: true })], { align: "center", gap: 1 }),
      spacer(),
      text(`${state.device ? `♪ ${state.device}` : ""}`, { dim: true }),
    ];

    if (state.upNext.length) {
      nodes.push(spacer(), divider(W - 1), text("up next", { dim: true }));
      for (const q of state.upNext) {
        nodes.push(
          recordRow([{ text: q.track, grow: true }, { text: q.artist, width: Math.min(28, Math.floor(W * 0.3)), align: "right" }], { width: W, color: FG }),
        );
      }
    }

    return [col(nodes)];
  },
});
