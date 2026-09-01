import { defineApplet, text, spacer, col, row, type ViewNode } from "../../sdk/index.ts";
import { progress, divider, recordRow } from "../../sdk/components.ts";
import {
  nowPlaying,
  play,
  pause,
  next,
  previous,
  searchTracks,
  playUris,
  type QueueItem,
  type SearchResult,
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
  // search
  mode: "now" | "results";
  query: string;
  results: SearchResult[];
  cursor: number;
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
    results: [],
    cursor: 0,
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
      state.mode = "results";
      state.cursor = 0;
      state.loading = true;
      emit();
      try {
        state.results = await searchTracks(state.query);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { query: state.query, count: state.results.length };
    },
    async playSelected(_a, { state, emit }) {
      const r = state.results[state.cursor];
      if (!r) return {};
      try {
        await playUris([r.uri]);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      state.mode = "now";
      await Bun.sleep(400);
      await loadNow(state, emit);
      return { playing: r.track };
    },
    back(_a, { state, emit }) {
      state.mode = "now";
      emit();
    },
    up(_a, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_a, { state, emit }) {
      state.cursor = Math.min(state.results.length - 1, state.cursor + 1);
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
  },

  nav: {
    up: "up",
    down: "down",
    select: "playSelected",
    selectLabel: "play",
    back: "back",
    backLabel: "now playing",
    canBack: (s) => s.mode === "results",
  },

  search: { verb: "search", placeholder: "search spotify tracks…" },

  crumb: (s) => (s.mode === "results" ? `search: ${s.query}` : null),

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

    // Search results
    if (state.mode === "results") {
      const head = state.loading
        ? text("searching…", { color: AMBER })
        : text(`results for "${state.query}"   ${state.results.length}`, { dim: true });
      const rows: ViewNode[] = state.results.map((r, i) =>
        recordRow(
          [
            { text: r.track, grow: true },
            { text: r.artist, width: Math.min(24, Math.floor(W * 0.24)) },
            { text: r.album, width: Math.min(24, Math.floor(W * 0.24)) },
          ],
          { width: W, selected: i === state.cursor, accent: GREEN, color: FG },
        ),
      );
      if (!rows.length && !state.loading) rows.push(text("no matches", { dim: true }));
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
