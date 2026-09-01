import { defineApplet, big, text, spacer } from "../../sdk/index.ts";

// state -> color: green running, amber paused, red done, dim idle
const RUNNING = "#00d488";
const PAUSED = "#f0b000";
const DONE = "#ff5c57";
const IDLE = "#5a5a5a";

function tint(s: { running: boolean; remaining: number; label: string }): string {
  if (s.running) return RUNNING;
  if (s.remaining > 0) return PAUSED;
  if (s.label) return DONE; // finished (label survives until stop)
  return IDLE;
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
  initialState: { remaining: 0, running: false, label: "" },

  verbs: {
    start(args, { state, emit }) {
      state.remaining = parseDuration(args.seconds ?? args.duration ?? args.for);
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
      state.remaining += parseDuration(args.seconds ?? args.duration ?? 60);
      emit();
    },
    stop(_args, { state, emit }) {
      state.remaining = 0;
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
    space: "toggle",
    s: "stop",
    r: "resume",
    p: "pause",
    a: { verb: "add", args: { seconds: 60 } },
  },

  accent: tint,

  view(state) {
    const done = !state.running && state.remaining === 0 && !!state.label;
    const status = state.running ? "running" : state.remaining > 0 ? "paused" : done ? "done" : "idle";
    const color = tint(state);
    return [
      spacer(),
      big(fmt(state.remaining), color, "block"),
      spacer(),
      text(`${status}${state.label ? `  ·  ${state.label}` : ""}`, { color }),
      text("space pause/resume   ·   a +1m   ·   s stop", { dim: true }),
    ];
  },
});
