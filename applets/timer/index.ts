import { defineApplet, big, text, spacer, col, theme, type ViewNode } from "../../sdk/index.ts";
import { progress, divider, recordRow } from "../../sdk/components.ts";
import { notify } from "../../server/notify.ts";

/**
 * timer — several countdowns at once, with quick presets.
 *
 * The point of this applet is NOT the timer. It is that:
 *   - you can press `space` in the TUI to pause the selected countdown, AND
 *   - an agent can call `timer.start({seconds:300, label:"tea"})` with no
 *     window open — and address any timer by id or label afterwards,
 * and both drive the exact same state. If an agent-started countdown can be
 * paused by your keypress, the bimodal platform works.
 */

interface Timer {
  /** Stable handle so an agent can act on one countdown among many. */
  id: string;
  label: string;
  remaining: number; // seconds
  total: number; // seconds this countdown started at (for the bar)
  running: boolean;
}

interface TimerState {
  timers: Timer[];
  cursor: number; // index of the selected timer
}

/** The quick presets, in keymap order (1/2/3). */
const PRESETS = [
  { key: "1", seconds: 300, label: "5m" },
  { key: "2", seconds: 900, label: "15m" },
  { key: "3", seconds: 1500, label: "25m" },
] as const;

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
    const n = parseInt(m[1]!, 10);
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

const isDone = (t: Timer) => !t.running && t.remaining === 0 && t.total > 0;

// state -> theme role: ok running, warn paused, error done, muted idle. The
// hexes live in ~/.config/kona/config.toml, so retheming kona retints the timer.
function tintOf(t: Timer | undefined): string {
  const th = theme();
  if (!t) return th.muted;
  if (t.running) return th.ok;
  if (t.remaining > 0) return th.warn;
  return isDone(t) ? th.error : th.muted;
}

function statusOf(t: Timer): string {
  return t.running ? "running" : t.remaining > 0 ? "paused" : isDone(t) ? "done" : "idle";
}

let seq = 0;
/** Ids are unique within a daemon run and readable in an agent's transcript. */
function nextId(state: TimerState): string {
  let id: string;
  do {
    id = `t${++seq}`;
  } while (state.timers.some((t) => t.id === id));
  return id;
}

function clampCursor(state: TimerState) {
  state.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, state.timers.length - 1));
}

/** The selected timer. Pure — `view`/`accent` call it too. */
function selected(state: TimerState): Timer | undefined {
  const i = Math.min(Math.max(0, state.cursor), state.timers.length - 1);
  return state.timers[i];
}

/**
 * Which timer a verb acts on. YOU get the selected one; an AGENT can name any
 * of them by `id`, by `label`, or by `index` — same verb either way.
 */
function target(
  state: TimerState,
  args: Record<string, unknown>,
  keys: string[] = ["id", "timer", "label", "name"],
): Timer | undefined {
  const named = keys.map((k) => args[k]).find((v) => typeof v === "string");
  if (typeof named === "string" && named.trim()) {
    const key = named.trim().toLowerCase();
    return (
      state.timers.find((t) => t.id.toLowerCase() === key) ??
      state.timers.find((t) => t.label.toLowerCase() === key)
    );
  }
  if (typeof args.index === "number") return state.timers[args.index];
  return selected(state);
}

/** What a verb hands back to its caller — enough for an agent to act again. */
const summary = (t: Timer) => ({
  id: t.id,
  label: t.label,
  remaining: t.remaining,
  running: t.running,
  status: statusOf(t),
});

/** A bar narrow enough to live inside a list row: "███░░░░░". */
function miniBar(value: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return "█".repeat(filled).padEnd(width, "░");
}

export default defineApplet<TimerState>({
  id: "timer",
  title: "Timer",
  summary: "Several countdowns at once. Presets 1/2/3; space pauses the selected.",
  initialState: { timers: [], cursor: 0 },

  verbs: {
    // Starts a NEW countdown and selects it — unless `id`/`label` names one
    // that already exists, in which case it restarts that one in place.
    start(args, { state, emit }) {
      const seconds = parseDuration(args.seconds ?? args.duration ?? args.for);
      const label = typeof args.label === "string" ? args.label : "";
      const existing =
        typeof args.id === "string" ? state.timers.find((t) => t.id === args.id) : undefined;
      const t = existing ?? {
        id: nextId(state),
        label,
        remaining: 0,
        total: 0,
        running: false,
      };
      t.label = label || t.label;
      t.remaining = seconds;
      t.total = seconds;
      t.running = seconds > 0;
      if (!existing) state.timers.push(t);
      state.cursor = state.timers.indexOf(t);
      emit();
      return summary(t);
    },
    pause(args, { state, emit }) {
      const t = target(state, args);
      if (!t) return {};
      t.running = false;
      emit();
      return summary(t);
    },
    resume(args, { state, emit }) {
      const t = target(state, args);
      if (!t) return {};
      if (t.remaining > 0) t.running = true;
      emit();
      return summary(t);
    },
    toggle(args, { state, emit }) {
      const t = target(state, args);
      if (!t) return {};
      t.running = t.remaining > 0 ? !t.running : false;
      emit();
      return summary(t);
    },
    add(args, { state, emit }) {
      const t = target(state, args);
      if (!t) return {};
      const delta = parseDuration(args.seconds ?? args.duration ?? 60);
      t.remaining += delta;
      t.total += delta;
      emit();
      return summary(t);
    },
    // Stop removes the countdown from the list; `all` clears every one.
    stop(args, { state, emit }) {
      if (args.all) {
        const removed = state.timers.length;
        state.timers = [];
        clampCursor(state);
        emit();
        return { removed };
      }
      const t = target(state, args);
      if (!t) return { removed: 0 };
      state.timers = state.timers.filter((x) => x !== t);
      clampCursor(state);
      emit();
      return { removed: 1, id: t.id };
    },
    /** Drop the countdowns that already finished. */
    clear(_args, { state, emit }) {
      const before = state.timers.length;
      state.timers = state.timers.filter((t) => !isDone(t));
      clampCursor(state);
      emit();
      return { removed: before - state.timers.length };
    },
    /** Name a timer — the agent-facing half of "start me a timer for X". */
    label(args, { state, emit }) {
      const t = target(state, args, ["id", "timer"]); // label/name are the NEW name
      if (!t) return {};
      const name = args.to ?? args.text ?? args.label ?? args.name;
      t.label = typeof name === "string" ? name : "";
      emit();
      return summary(t);
    },
    select(args, { state, emit }) {
      const t = target(state, args);
      if (t) state.cursor = state.timers.indexOf(t);
      emit();
      return t ? summary(t) : {};
    },
    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(Math.max(0, state.timers.length - 1), state.cursor + 1);
      emit();
    },
  },

  /**
   * v0 kept ONE countdown at the top level of the state. A daemon restarting on
   * persisted v0 state folds it into the list so an in-flight countdown (and the
   * disk file) doesn't strand.
   */
  init({ state, emit }) {
    const legacy = state as unknown as Partial<{ remaining: number; total: number; running: boolean; label: string }>;
    if (typeof legacy.remaining !== "number") return;
    if (legacy.remaining > 0 || legacy.running) {
      state.timers.push({
        id: nextId(state),
        label: legacy.label ?? "",
        remaining: legacy.remaining,
        total: legacy.total ?? legacy.remaining,
        running: !!legacy.running,
      });
    }
    for (const k of ["remaining", "total", "running", "label"]) delete (legacy as Record<string, unknown>)[k];
    clampCursor(state);
    emit();
  },

  tickMs: 1000,
  tick({ state, emit }) {
    let moved = false;
    for (const t of state.timers) {
      if (!t.running || t.remaining <= 0) continue;
      t.remaining -= 1;
      if (t.remaining <= 0) {
        t.remaining = 0;
        t.running = false;
        // The whole point of a timer you can walk away from: the daemon counts
        // down whether or not the view is open, so tell the desktop. A distinct
        // key per timer lets concurrent completions dedupe independently.
        void notify({
          event: "timer.done",
          title: t.label ? `Timer — ${t.label}` : "Timer done",
          body: `${fmt(t.total)} is up.`,
          key: `timer.done:${t.id}:${t.label}:${t.total}`,
        });
      }
      moved = true;
    }
    if (moved) emit();
  },

  keymap: {
    space: { verb: "toggle", label: "pause/resume" },
    a: { verb: "add", args: { seconds: 60 }, label: "+1m" },
    s: { verb: "stop", label: "stop" },
    c: { verb: "clear", label: "clear" },
    ...Object.fromEntries(
      PRESETS.map((p) => [p.key, { verb: "start", args: { seconds: p.seconds }, label: p.label }]),
    ),
  },

  nav: { up: "up", down: "down" },

  accent: (state) => tintOf(selected(state)),

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 62);
    const sel = selected(state);

    if (!sel) {
      return [
        col(
          [
            text("no timers", { color: theme().muted }),
            spacer(),
            text(`press ${PRESETS.map((p) => `${p.key} ${p.label}`).join("  ·  ")}`, { dim: true }),
            text("or:  kona call timer start '{\"seconds\":300}'", { dim: true }),
          ],
          { align: "center", justify: "center", grow: true },
        ),
      ];
    }

    // The selected countdown, big.
    const color = tintOf(sel);
    const hero = col(
      [
        big(fmt(sel.remaining), color, "block"),
        spacer(),
        progress(sel.total > 0 ? sel.remaining / sel.total : 0, { color, width: 28 }),
        spacer(),
        text(`${statusOf(sel)}${sel.label ? `  ·  ${sel.label}` : ""}`, { color }),
      ],
      { align: "center" },
    );

    if (state.timers.length === 1) return [hero];

    // ...and the whole roster below it, mini bar each, selection highlighted.
    const barW = Math.min(14, Math.max(6, Math.floor(W * 0.2)));
    const rows: ViewNode[] = state.timers.map((t, i) => {
      const tint = tintOf(t);
      return recordRow(
        [
          { text: t.running ? "▶" : isDone(t) ? "✓" : "⏸", width: 1 },
          { text: t.label || t.id, grow: true },
          { text: miniBar(t.total > 0 ? t.remaining / t.total : 0, barW), width: barW },
          { text: fmt(t.remaining), width: 8, align: "right" },
        ],
        { width: W, selected: i === state.cursor, accent: tint, color: tint },
      );
    });

    return [
      col([
        hero,
        spacer(),
        divider(W - 1),
        text(`${state.timers.length} timers`, { dim: true }),
        ...rows,
      ]),
    ];
  },
});
