import { defineApplet, big, text, spacer, col, theme, appletConfig, appletString, type ViewNode } from "../../sdk/index.ts";
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
 *
 * On top of that sits POMODORO MODE: one cycling countdown (work -> short break
 * -> ... -> long break) that advances itself and banners the desktop at every
 * phase boundary. It is a mode, not a replacement — the plain countdowns keep
 * running underneath it, and `p` / `timer.pomodoro.start` reach the same session.
 *
 * The session is not a second applet bolted on, though: it is the FIRST ROW of
 * the same list. A live session and the countdowns share one selection
 * (`state.focus` + `state.cursor`), so `up`/`down` walk across all of them, the
 * selected one is the hero, and `space` pauses whichever it is — you never have
 * to know which of two pause keys the screen is currently listening to.
 */

interface Timer {
  /** Stable handle so an agent can act on one countdown among many. */
  id: string;
  label: string;
  remaining: number; // seconds
  total: number; // seconds this countdown started at (for the bar)
  running: boolean;
}

/** Where a pomodoro session currently is in its cycle. */
type Phase = "work" | "short" | "long";

/** Phase lengths and cadence: the shape of one cycle. */
interface Plan {
  work: number; // seconds
  short: number; // seconds
  long: number; // seconds
  /** A long break after every Nth work phase. */
  every: number;
  /** Roll into the next phase on its own, or park it until you say go. */
  auto: boolean;
}

interface Pomodoro {
  /** Is a session on? The plain countdowns run either way. */
  active: boolean;
  phase: Phase;
  /** Which work round of this cycle we're on, 1..plan.every. */
  round: number;
  remaining: number; // seconds
  total: number; // seconds this phase started at
  running: boolean;
  /** Auto-advance off: the next phase is loaded but paused, waiting for you. */
  awaiting: boolean;
  /** Work phases that reached zero on `day` — the "3 done today" count. */
  completed: number;
  day: string; // YYYY-MM-DD the count belongs to
  /** The plan this session started under; config supplies it, a verb may override. */
  plan: Plan;
}

/**
 * Which slot the cursor is on: the pomodoro session (when one is live) or the
 * countdowns, where `cursor` picks which. One selection over both, so there is
 * one thing "the selected timer" can mean.
 */
type Focus = "pomodoro" | "timers";

interface TimerState {
  timers: Timer[];
  cursor: number; // index of the selected timer
  focus: Focus; // which slot the cursor is on
  pomodoro: Pomodoro;
}

/** The quick presets, in keymap order (1/2/3). */
const PRESETS = [
  { key: "1", seconds: 300, label: "5m" },
  { key: "2", seconds: 900, label: "15m" },
  { key: "3", seconds: 1500, label: "25m" },
] as const;

/** The classic cycle, and what you get with no config file at all. */
const DEFAULT_PLAN: Plan = { work: 1500, short: 300, long: 900, every: 4, auto: true };

const PHASE_LABEL: Record<Phase, string> = {
  work: "work",
  short: "short break",
  long: "long break",
};

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

// --- pomodoro ---------------------------------------------------------------

/** Local calendar day, so "done today" rolls over at midnight where you are. */
function today(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A phase length. A duration string is read as written ("25m", "90s"); a bare
 * number is MINUTES, because nobody configures a 25-second work phase.
 */
function phaseLength(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v * 60);
  if (typeof v === "string") {
    const s = parseDuration(v);
    if (s > 0) return s;
  }
  return fallback;
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/**
 * The plan from `~/.config/kona/config.toml`:
 *
 *   [applets.timer.pomodoro]
 *   work  = "25m"   # duration string, or a bare number of MINUTES
 *   short = "5m"
 *   long  = "15m"
 *   every = 4       # long break after every 4th work phase
 *   auto  = false   # wait for `p` at each boundary instead of rolling on
 *
 * Every key is optional; a missing or malformed one falls back to DEFAULT_PLAN,
 * exactly like the rest of kona's config.
 */
function configPlan(): Plan {
  const raw = appletConfig("timer").pomodoro;
  const cfg = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    work: phaseLength(cfg.work, DEFAULT_PLAN.work),
    short: phaseLength(cfg.short, DEFAULT_PLAN.short),
    long: phaseLength(cfg.long, DEFAULT_PLAN.long),
    every: positiveInt(cfg.every, DEFAULT_PLAN.every),
    auto: typeof cfg.auto === "boolean" ? cfg.auto : DEFAULT_PLAN.auto,
  };
}

/** Config first, then whatever the caller of `pomodoro.start` asked for. */
function planFrom(args: Record<string, unknown>, base: Plan): Plan {
  return {
    work: phaseLength(args.work ?? args.seconds ?? args.duration, base.work),
    short: phaseLength(args.short ?? args.break, base.short),
    long: phaseLength(args.long ?? args.longBreak, base.long),
    every: positiveInt(args.every ?? args.rounds, base.every),
    auto: typeof args.auto === "boolean" ? args.auto : base.auto,
  };
}

function freshPomodoro(): Pomodoro {
  return {
    active: false,
    phase: "work",
    round: 1,
    remaining: 0,
    total: 0,
    running: false,
    awaiting: false,
    completed: 0,
    day: "",
    plan: configPlan(),
  };
}

/** The tally belongs to a day; crossing midnight starts a new one. */
function rollDay(p: Pomodoro) {
  const d = today();
  if (p.day !== d) {
    p.day = d;
    p.completed = 0;
  }
}

function lengthOf(p: Pomodoro, phase: Phase): number {
  return phase === "work" ? p.plan.work : phase === "short" ? p.plan.short : p.plan.long;
}

/** Work, then a break; every `every`th break is the long one. */
function nextPhase(p: Pomodoro): Phase {
  if (p.phase !== "work") return "work";
  return p.round % p.plan.every === 0 ? "long" : "short";
}

function pomoStatus(p: Pomodoro): string {
  if (!p.active) return "off";
  if (p.running) return "running";
  return p.awaiting ? "waiting" : "paused";
}

/**
 * A phase boundary is the whole point of the mode, so it reaches the desktop:
 * a distinct `timer.pomodoro` event (toggleable on its own in `kona notify`),
 * keyed per transition so two boundaries never dedupe into one.
 */
function notifyPhase(p: Pomodoro, from: Phase) {
  const onBreak = p.phase !== "work";
  void notify({
    event: "timer.pomodoro",
    title: onBreak ? "Time for a break" : "Break's over, back to it",
    body: onBreak
      ? `${fmt(p.total)} ${PHASE_LABEL[p.phase]} — ${p.completed} done today.`
      : `${fmt(p.total)} of work · round ${p.round}/${p.plan.every}.`,
    key: `timer.pomodoro:${from}->${p.phase}:${p.round}:${p.completed}`,
  });
}

/**
 * Move onto the next phase. `ran` marks a phase that reached zero on its own —
 * that is what counts a pomodoro and what earns a banner. A manual skip travels
 * the same path quietly: you are already at the keyboard.
 */
function advance(p: Pomodoro, ran: boolean) {
  const from = p.phase;
  const next = nextPhase(p);
  if (from === "work") {
    if (ran) {
      rollDay(p);
      p.completed += 1;
    }
  } else {
    // A finished break opens the next round — or the next cycle after a long one.
    p.round = from === "long" ? 1 : p.round + 1;
  }
  p.phase = next;
  p.total = lengthOf(p, next);
  p.remaining = p.total;
  p.running = p.plan.auto;
  p.awaiting = !p.plan.auto;
  if (ran) notifyPhase(p, from);
}

/** Begin (or restart) a session at work round 1. */
function startSession(p: Pomodoro, args: Record<string, unknown>) {
  p.plan = planFrom(args, configPlan());
  rollDay(p);
  p.active = true;
  p.phase = "work";
  p.round = 1;
  p.total = p.plan.work;
  p.remaining = p.total;
  p.running = true;
  p.awaiting = false;
}

/**
 * The session's half of pause/resume/toggle/stop, as plain functions rather
 * than verb bodies: `pomodoro.pause` and a `space` that landed on the session
 * must do the SAME thing, so they call the same code.
 */
function pomoPause(p: Pomodoro) {
  p.running = false;
}

/** Also the "go" at a boundary when auto-advance is off. */
function pomoResume(p: Pomodoro) {
  if (p.active && p.remaining > 0) {
    p.running = true;
    p.awaiting = false;
  }
}

/** The whole life cycle on one key: off -> start, running -> pause, else go. */
function pomoToggle(p: Pomodoro, args: Record<string, unknown>) {
  if (!p.active) startSession(p, args);
  else if (p.running) pomoPause(p);
  else pomoResume(p);
}

/** End the session. Today's tally survives — you did do those. */
function pomoStop(p: Pomodoro) {
  p.active = false;
  p.running = false;
  p.awaiting = false;
  p.remaining = 0;
  p.total = 0;
}

/** "one more minute" on the phase you are in. */
function pomoAdd(p: Pomodoro, delta: number) {
  p.remaining += delta;
  p.total += delta;
}

/** What a pomodoro verb hands back — enough for an agent to decide what next. */
const pomoSummary = (p: Pomodoro) => ({
  kind: "pomodoro" as const,
  active: p.active,
  phase: p.phase,
  phaseLabel: PHASE_LABEL[p.phase],
  round: p.round,
  rounds: p.plan.every,
  remaining: p.remaining,
  running: p.running,
  awaiting: p.awaiting,
  completed: p.completed,
  status: pomoStatus(p),
});

/**
 * state -> theme role, per phase: work wears the accent, a break wears `ok`,
 * and anything not counting down is `warn` (paused) or `muted` (off).
 */
function pomoTint(p: Pomodoro | undefined): string {
  const th = theme();
  if (!p || !p.active) return th.muted;
  if (!p.running) return th.warn;
  return p.phase === "work" ? th.accent : th.ok;
}

/** "● ● ◐ ○" — rounds done this cycle, the current one half-filled. */
function roundDots(p: Pomodoro): string {
  const done = p.phase === "work" ? p.round - 1 : p.round;
  return Array.from({ length: p.plan.every }, (_, i) =>
    i < done ? "●" : i === done && p.phase === "work" ? "◐" : "○",
  ).join(" ");
}

/**
 * Fill in — or repair — the pomodoro slice. A `state.json` written before this
 * mode existed has no `pomodoro` key at all, and the daemon's shallow merge
 * would otherwise hand us the shared `initialState` object to mutate.
 */
function normalize(state: TimerState) {
  const saved = state.pomodoro as Partial<Pomodoro> | undefined;
  const base = freshPomodoro();
  const p: Pomodoro = { ...base, ...(saved && typeof saved === "object" ? saved : {}) };
  const plan = saved?.plan;
  // A live session keeps the plan it started under; an idle one re-reads config.
  p.plan = p.active && plan && typeof plan === "object" ? { ...base.plan, ...plan } : base.plan;
  rollDay(p);
  state.pomodoro = p;
  // State written before the two halves shared a selection has no `focus`; a
  // live session is what you were looking at, so that is where it lands.
  state.focus = state.focus === "timers" ? "timers" : "pomodoro";
}

// --- countdowns --------------------------------------------------------------

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
 * Is the pomodoro the selected slot — the thing `space` acts on and the hero
 * shows? Only a live session can hold the selection, and it holds it by default
 * (starting one is a choice to look at it). With no countdowns left there is
 * nothing else the cursor could be on, so it comes back regardless.
 */
function pomoFocused(state: TimerState): boolean {
  if (!state.pomodoro?.active) return false;
  return state.focus === "pomodoro" || state.timers.length === 0;
}

/** How many rows the one list has: the session, if live, plus the countdowns. */
function slotCount(state: TimerState): number {
  return (state.pomodoro?.active ? 1 : 0) + state.timers.length;
}

/** Does this call name a countdown outright? Then it means that one, always. */
function namesTimer(args: Record<string, unknown>): boolean {
  if (typeof args.index === "number") return true;
  return ["id", "timer", "label", "name"].some(
    (k) => typeof args[k] === "string" && (args[k] as string).trim() !== "",
  );
}

/**
 * Does a bare `pause`/`resume`/`toggle`/`add`/`stop` mean the session?
 *
 * "Pause what I'm looking at" is the whole point of one pause key: with a
 * session selected, `space` (and an agent's argument-less call) reaches it
 * instead of silently doing nothing to a countdown behind it. Naming a
 * countdown — by `id`, `label` or `index` — always wins over the selection.
 */
function meansPomodoro(state: TimerState, args: Record<string, unknown>): boolean {
  return pomoFocused(state) && !namesTimer(args);
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

/**
 * What a verb hands back to its caller — enough for an agent to act again.
 * `kind` says WHICH of the two a shared verb acted on, since `pause` with no
 * argument may well have reached the pomodoro.
 */
const summary = (t: Timer) => ({
  kind: "timer" as const,
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

/**
 * The one list: a live session on top, then every countdown, each a mini-bar
 * row with the selection highlighted. The session is a row like any other so
 * that walking the list with `up`/`down` crosses it — the alternative is two
 * lists and a hidden rule about which one the keyboard is talking to.
 */
function roster(state: TimerState, width: number): ViewNode[] {
  const barW = Math.min(14, Math.max(6, Math.floor(width * 0.2)));
  interface Row {
    mark: string;
    label: string;
    remaining: number;
    total: number;
    tint: string;
    selected: boolean;
  }
  const render = (r: Row) =>
    recordRow(
      [
        { text: r.mark, width: 1 },
        { text: r.label, grow: true },
        { text: miniBar(r.total > 0 ? r.remaining / r.total : 0, barW), width: barW },
        { text: fmt(r.remaining), width: 8, align: "right" },
      ],
      { width, selected: r.selected, accent: r.tint, color: r.tint },
    );

  const onPomo = pomoFocused(state);
  const rows: Row[] = [];
  const p = state.pomodoro;
  if (p?.active) {
    rows.push({
      mark: p.running ? "▶" : "⏸",
      label: `pomodoro · ${PHASE_LABEL[p.phase]}`,
      remaining: p.remaining,
      total: p.total,
      tint: pomoTint(p),
      selected: onPomo,
    });
  }
  for (const [i, t] of state.timers.entries()) {
    rows.push({
      mark: t.running ? "▶" : isDone(t) ? "✓" : "⏸",
      label: t.label || t.id,
      remaining: t.remaining,
      total: t.total,
      tint: tintOf(t),
      selected: !onPomo && i === state.cursor,
    });
  }
  return rows.map(render);
}

/** "pomodoro · 2 timers" — what the list below the hero is holding. */
function rosterLabel(state: TimerState): string {
  const n = state.timers.length;
  const parts: string[] = [];
  if (state.pomodoro?.active) parts.push("pomodoro");
  if (n) parts.push(`${n} ${n === 1 ? "timer" : "timers"}`);
  return parts.join("  ·  ");
}

/** One countdown, big: what is left, how far through, and what it is called. */
function timerHero(t: Timer): ViewNode {
  const color = tintOf(t);
  return col(
    [
      big(fmt(t.remaining), color, "block"),
      spacer(),
      progress(t.total > 0 ? t.remaining / t.total : 0, { color, width: 28 }),
      spacer(),
      text(`${statusOf(t)}${t.label ? `  ·  ${t.label}` : ""}`, { color }),
    ],
    { align: "center" },
  );
}

/** The session, big: which phase, which round, and how many you have banked. */
function pomodoroHero(p: Pomodoro): ViewNode {
  const color = pomoTint(p);
  const status = p.awaiting
    ? `press space to start the ${PHASE_LABEL[p.phase]}`
    : p.running
      ? `${PHASE_LABEL[p.phase]} · space pauses · n skips`
      : `paused · space resumes`;
  return col(
    [
      text(`pomodoro  ·  ${PHASE_LABEL[p.phase]}`, { color }),
      big(fmt(p.remaining), color, "block"),
      spacer(),
      progress(p.total > 0 ? p.remaining / p.total : 0, { color, width: 28 }),
      spacer(),
      text(`${roundDots(p)}   round ${p.round}/${p.plan.every}`, { color }),
      text(status, { dim: true }),
      text(`${p.completed} done today`, { dim: true }),
    ],
    { align: "center" },
  );
}

export default defineApplet<TimerState>({
  id: "timer",
  title: "Timer",
  summary: "Countdowns and a pomodoro. Presets 1/2/3; space pauses; p pomodoro.",
  icon: "⏱",
  tint: "#ff5c57", // countdown red
  labels: ["time", "focus"],
  // `kona timer 5m`, `kona timer pomodoro`, and the configured preset — the CLI
  // learns all three from here rather than special-casing this applet.
  cli: {
    usage: "kona timer 5m | kona timer pomodoro",
    open: (args, state) => {
      const arg = args[0] ?? "";
      if (arg === "pomodoro") return { verb: "pomodoro.start" };
      if (arg) return { verb: "start", args: { seconds: arg } };
      // With no argument the config preset starts a countdown — but only when
      // nothing is already ticking, so `kona timer` just opens what's running.
      const preset = appletString("timer", "default", "");
      const busy = state.timers.some((t) => t.running) || state.pomodoro.active;
      return preset && !busy ? { verb: "start", args: { seconds: preset } } : null;
    },
  },
  notifications: {
    "timer.done": { summary: "a countdown reaches zero", default: true },
    "timer.pomodoro": { summary: "a pomodoro work or break phase ends", default: true },
  },
  configSample: `[applets.timer]
default = "5m"       # \`kona timer\` with no argument

# Pomodoro mode (\`p\` in the TUI, \`timer.pomodoro.start\` for an agent).
# Durations may be written "25m" or as a bare number of MINUTES.
[applets.timer.pomodoro]
work  = "25m"
short = "5m"
long  = "15m"
every = 4            # long break after every 4th work phase
auto  = true         # false: wait for \`p\` at each phase boundary`,
  initialState: {
    timers: [],
    cursor: 0,
    // A session, once started, is what you are looking at until you move off it.
    focus: "pomodoro" as Focus,
    // Config is read when a session starts, so the shipped defaults are enough here.
    pomodoro: {
      active: false,
      phase: "work",
      round: 1,
      remaining: 0,
      total: 0,
      running: false,
      awaiting: false,
      completed: 0,
      day: "",
      plan: { ...DEFAULT_PLAN },
    },
  },

  /** What an agent reads in `kona tools` / the generated skill. */
  docs: {
    start: {
      doc: "Start a countdown. `seconds` takes 300, \"5m\" or \"1h30m\"; `label` names it. Naming an existing `id` restarts that one.",
      args: { seconds: 300, label: "tea" },
    },
    pause: {
      doc: "Pause a countdown — by `id`, `label`, `index`, else the selection, which may be a live pomodoro (`kind` in the reply says which it was).",
      args: { id: "t1" },
    },
    resume: { doc: "Resume whatever `pause` paused — the named countdown, else the selection.", args: { id: "t1" } },
    toggle: {
      doc: "Pause or resume, whichever applies (the `space` key). With a pomodoro selected and no countdown named, it drives the session.",
      args: { id: "t1" },
    },
    add: { doc: "Add time to a running countdown, or to the current pomodoro phase.", args: { id: "t1", seconds: 60 } },
    stop: {
      doc: "Remove a countdown; `{\"all\":true}` clears every one. With a pomodoro selected and none named, it ends the session.",
      args: { id: "t1" },
    },
    clear: "Drop the countdowns that already finished.",
    label: { doc: "Rename a countdown.", args: { id: "t1", to: "steep" } },
    select: {
      doc: "Move the human's selection to a countdown, or onto a live session with `{\"pomodoro\":true}`.",
      args: { id: "t1" },
    },
  },

  recipes: [
    {
      title: "Start a focus timer, then extend it",
      steps: [
        `kona call timer start '{"seconds":1500,"label":"focus"}'   # -> { id: "t1", status: "running" }`,
        `kona state timer                                            # every countdown, with remaining`,
        `kona call timer add '{"id":"t1","seconds":300}'             # +5m, without touching the cursor`,
      ],
      note: "Address the countdown by the `id` the start verb handed back — never by moving the cursor, which the human may also be moving. When it hits zero the daemon posts a desktop banner (`kona notify on timer.done`).",
    },
    {
      title: "Pause whatever the human is looking at",
      steps: [
        `kona call timer toggle '{}'                                 # -> { kind: "pomodoro", status: "paused" }`,
        `kona call timer toggle '{"id":"t1"}'                        # ...or that countdown, whatever is selected`,
      ],
      note: "A live pomodoro and the countdowns share one selection, so an argument-less `pause`/`resume`/`toggle`/`add`/`stop` reaches whichever the human has on screen — `kind` in the reply says which it was. Name a countdown to reach it regardless.",
    },
  ],

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
      state.focus = "timers"; // starting a countdown selects it, session or no
      emit();
      return summary(t);
    },
    pause(args, { state, emit }) {
      if (meansPomodoro(state, args)) {
        pomoPause(state.pomodoro);
        emit();
        return pomoSummary(state.pomodoro);
      }
      const t = target(state, args);
      if (!t) return {};
      t.running = false;
      emit();
      return summary(t);
    },
    resume(args, { state, emit }) {
      if (meansPomodoro(state, args)) {
        pomoResume(state.pomodoro);
        emit();
        return pomoSummary(state.pomodoro);
      }
      const t = target(state, args);
      if (!t) return {};
      if (t.remaining > 0) t.running = true;
      emit();
      return summary(t);
    },
    // The `space` key. It follows the selection, so it reaches a live pomodoro
    // instead of quietly doing nothing while the session owns the screen.
    toggle(args, { state, emit }) {
      if (meansPomodoro(state, args)) {
        pomoToggle(state.pomodoro, args);
        emit();
        return pomoSummary(state.pomodoro);
      }
      const t = target(state, args);
      if (!t) return {};
      t.running = t.remaining > 0 ? !t.running : false;
      emit();
      return summary(t);
    },
    add(args, { state, emit }) {
      const delta = parseDuration(args.seconds ?? args.duration ?? 60);
      if (meansPomodoro(state, args)) {
        pomoAdd(state.pomodoro, delta);
        emit();
        return pomoSummary(state.pomodoro);
      }
      const t = target(state, args);
      if (!t) return {};
      t.remaining += delta;
      t.total += delta;
      emit();
      return summary(t);
    },
    // Stop removes the countdown from the list; `all` clears every one. On the
    // session it is `x`: end it, and fall back to the countdowns underneath.
    stop(args, { state, emit }) {
      if (args.all) {
        const removed = state.timers.length;
        state.timers = [];
        clampCursor(state);
        emit();
        return { removed };
      }
      if (meansPomodoro(state, args)) {
        pomoStop(state.pomodoro);
        state.focus = "timers";
        emit();
        return { removed: 1, ...pomoSummary(state.pomodoro) };
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
    /** Move the selection — onto a countdown, or onto the session itself. */
    select(args, { state, emit }) {
      const named = [args.id, args.timer, args.label, args.name].find((v) => typeof v === "string");
      const asksPomodoro =
        args.pomodoro === true ||
        (typeof named === "string" && named.trim().toLowerCase() === "pomodoro");
      // A countdown that answers to the name given wins — one may well be
      // labelled "pomodoro"; `{"pomodoro":true}` always means the session.
      const t = args.pomodoro === true ? undefined : target(state, args);
      if (!t && asksPomodoro && state.pomodoro.active) {
        state.focus = "pomodoro";
        emit();
        return pomoSummary(state.pomodoro);
      }
      if (t) {
        state.cursor = state.timers.indexOf(t);
        state.focus = "timers";
      }
      emit();
      return t ? summary(t) : {};
    },
    /**
     * Pomodoro. Dotted names so the mode reads as one family in the manifest
     * (`timer.pomodoro.start`, `.skip`, ...) and never collides with the plain
     * countdown verbs above. Every one of them is a keypress here and an HTTP
     * call there — "start a pomodoro" and `p` land in the same place.
     *
     * Args (all optional, all overriding `[applets.timer.pomodoro]`):
     * `work`, `short`, `long` (duration string, or a number of minutes),
     * `every` (long break cadence), `auto` (advance on its own).
     */
    "pomodoro.start"(args, { state, emit }) {
      const p = state.pomodoro;
      startSession(p, args);
      state.focus = "pomodoro"; // a session you just started is what you're on
      emit();
      return pomoSummary(p);
    },
    "pomodoro.pause"(_args, { state, emit }) {
      pomoPause(state.pomodoro);
      emit();
      return pomoSummary(state.pomodoro);
    },
    /** Also the "go" at a boundary when auto-advance is off. */
    "pomodoro.resume"(_args, { state, emit }) {
      pomoResume(state.pomodoro);
      emit();
      return pomoSummary(state.pomodoro);
    },
    /** The whole life cycle on one key: off -> start, running -> pause, else go. */
    "pomodoro.toggle"(args, { state, emit }) {
      const p = state.pomodoro;
      pomoToggle(p, args);
      if (p.active) state.focus = "pomodoro";
      emit();
      return pomoSummary(p);
    },
    /** "skip this break" — next phase, now. A skipped work phase does not count. */
    "pomodoro.skip"(_args, { state, emit }) {
      const p = state.pomodoro;
      if (!p.active) return pomoSummary(p);
      advance(p, false);
      p.running = p.remaining > 0;
      p.awaiting = false;
      emit();
      return pomoSummary(p);
    },
    /** End the session. Today's tally survives — you did do those. */
    "pomodoro.stop"(_args, { state, emit }) {
      pomoStop(state.pomodoro);
      state.focus = "timers"; // the countdowns underneath take the selection back
      emit();
      return pomoSummary(state.pomodoro);
    },
    // The cursor walks ONE list: a live session sits above the countdowns, so
    // `up` off the first countdown lands on it and `down` steps back off it.
    up(_args, { state, emit }) {
      if (pomoFocused(state)) return;
      if (state.cursor === 0 && state.pomodoro.active) state.focus = "pomodoro";
      else state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      if (pomoFocused(state)) {
        if (!state.timers.length) return;
        state.focus = "timers";
        state.cursor = 0;
      } else {
        state.cursor = Math.min(Math.max(0, state.timers.length - 1), state.cursor + 1);
      }
      emit();
    },
  },

  /**
   * v0 kept ONE countdown at the top level of the state. A daemon restarting on
   * persisted v0 state folds it into the list so an in-flight countdown (and the
   * disk file) doesn't strand.
   */
  init({ state, emit }) {
    // Also where a state.json from before pomodoro mode grows its slice.
    normalize(state);
    const legacy = state as unknown as Partial<{ remaining: number; total: number; running: boolean; label: string }>;
    if (typeof legacy.remaining === "number") {
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
    }
    clampCursor(state);
    emit();
  },

  tickMs: 1000,
  tick({ state, emit }) {
    let moved = false;
    // The pomodoro counts down in the daemon like any other countdown — and
    // hands itself to the next phase (and to the desktop) when it hits zero.
    const p = state.pomodoro;
    if (p?.active && p.running && p.remaining > 0) {
      p.remaining -= 1;
      if (p.remaining <= 0) advance(p, true);
      moved = true;
    }
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
    // One pause key for both: `toggle` follows the selection, so this is the
    // session while it is the hero and the countdown once you move off it.
    space: { verb: "toggle", label: "pause/resume" },
    p: { verb: "pomodoro.toggle", label: "pomodoro" },
    n: { verb: "pomodoro.skip", label: "skip phase", when: (s) => s.pomodoro?.active === true },
    x: { verb: "pomodoro.stop", label: "end pomodoro", when: (s) => s.pomodoro?.active === true },
    a: { verb: "add", args: { seconds: 60 }, label: "+1m" },
    s: { verb: "stop", label: "stop" },
    c: { verb: "clear", label: "clear" },
    ...Object.fromEntries(
      PRESETS.map((p) => [p.key, { verb: "start", args: { seconds: p.seconds }, label: p.label }]),
    ),
  },

  nav: { up: "up", down: "down" },

  // The frame follows the selection — the session's phase while it is the hero,
  // the selected countdown's state once you move onto one.
  accent: (state) =>
    pomoFocused(state) ? pomoTint(state.pomodoro) : tintOf(selected(state)),

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 62);
    const sel = selected(state);
    const pomo = state.pomodoro;

    if (!slotCount(state)) {
      return [
        col(
          [
            text("no timers", { color: theme().muted }),
            spacer(),
            text(`press ${PRESETS.map((p) => `${p.key} ${p.label}`).join("  ·  ")}`, { dim: true }),
            text("p starts a pomodoro", { dim: true }),
            text("or:  kona call timer start '{\"seconds\":300}'", { dim: true }),
          ],
          { align: "center", justify: "center", grow: true },
        ),
      ];
    }

    // The selection, big — the session or a countdown, whichever the cursor is
    // on. The other rows live in one list underneath, session included.
    const hero = pomoFocused(state) || !sel ? pomodoroHero(pomo) : timerHero(sel);
    if (slotCount(state) === 1) return [hero];

    return [
      col([
        hero,
        spacer(),
        divider(W - 1),
        text(rosterLabel(state), { dim: true }),
        ...roster(state, W),
      ]),
    ];
  },
});
