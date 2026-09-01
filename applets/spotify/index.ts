import { defineApplet, text, spacer, col, row, type ViewNode } from "../../sdk/index.ts";
import { progress, divider, recordRow } from "../../sdk/components.ts";
import { nowPlaying, play, pause, next, previous, type QueueItem } from "../../server/spotify.ts";

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
