import { defineApplet, big, text, spacer, col, theme } from "../../sdk/index.ts";
import { progress } from "../../sdk/components.ts";

// state -> theme role: ok running, warn paused, error done, muted idle. The
// hexes live in ~/.config/kona/config.toml, so retheming kona retints the timer.
function tint(s: { running: boolean; remaining: number; label: string }): string {
  const t = theme();
  if (s.running) return t.ok;
  if (s.remaining > 0) return t.warn;
  if (s.label) return t.error; // finished (label survives until stop)
  return t.muted;
}

/**
 * timer — the walking-skeleton proof.
 *
 * The point of this applet is NOT the timer. It is that:
 *   - you can press `space` in the TUI to pause it, AND
 *   - an agent can call `timer.start({seconds:300})` with no window open,
 * and both drive the exact same state. If an agent-started countdown can be
 * paused by your keypress, the bimodal platform works.
 */

interface TimerState {
  remaining: number; // seconds
  total: number; // seconds the current countdown started at (for the bar)
  running: boolean;
  label: string;
}

// Accept "5m", "90s", "1h30m", or a bare number of seconds.
function parseDuration(input: unknown): number {
  if (typeof input === "number") return Math.max(0, Math.floor(input));
  if (typeof input !== "string") return 0;
  const s = input.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  const re = /(\d+)\s*([hms])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1], 10);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
  }
  return total;
}

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

export default defineApplet<TimerState>({
  id: "timer",
  title: "Timer",
  summary: "Count down. Start by hand or by agent; pause with space.",
  initialState: { remaining: 0, total: 0, running: false, label: "" },

  verbs: {
    start(args, { state, emit }) {
      state.remaining = parseDuration(args.seconds ?? args.duration ?? args.for);
      state.total = state.remaining;
      state.label = typeof args.label === "string" ? args.label : "";
      state.running = state.remaining > 0;
      emit();
      return { remaining: state.remaining, running: state.running };
    },
    pause(_args, { state, emit }) {
      state.running = false;
      emit();
    },
    resume(_args, { state, emit }) {
      if (state.remaining > 0) state.running = true;
      emit();
    },
    toggle(_args, { state, emit }) {
      state.running = state.remaining > 0 ? !state.running : false;
      emit();
    },
    add(args, { state, emit }) {
      const delta = parseDuration(args.seconds ?? args.duration ?? 60);
      state.remaining += delta;
      state.total += delta;
      emit();
    },
    stop(_args, { state, emit }) {
      state.remaining = 0;
      state.total = 0;
      state.running = false;
      state.label = "";
      emit();
    },
  },

  tickMs: 1000,
  tick({ state, emit }) {
    if (!state.running || state.remaining <= 0) return;
    state.remaining -= 1;
    if (state.remaining <= 0) {
      state.remaining = 0;
      state.running = false;
    }
    emit();
  },

  keymap: {
    space: { verb: "toggle", label: "pause/resume" },
    a: { verb: "add", args: { seconds: 60 }, label: "+1m" },
    s: { verb: "stop", label: "stop" },
  },

  accent: tint,

  view(state) {
    const done = !state.running && state.remaining === 0 && !!state.label;
    const status = state.running ? "running" : state.remaining > 0 ? "paused" : done ? "done" : "idle";
    const color = tint(state);
    const frac = state.total > 0 ? state.remaining / state.total : 0;
    return [
      col(
        [
          big(fmt(state.remaining), color, "block"),
          spacer(),
          progress(frac, { color, width: 28 }),
          spacer(),
          text(`${status}${state.label ? `  ·  ${state.label}` : ""}`, { color }),
        ],
        { align: "center", justify: "center", grow: true },
      ),
    ];
  },
});
