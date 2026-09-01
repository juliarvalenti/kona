import { test, expect } from "bun:test";
import { theme, type AppletCtx, type ViewNode } from "../../sdk/index.ts";
import timer from "./index.ts";

/**
 * The timer applet is a pure reducer over its state: verbs and tick mutate the
 * same state and emit. These tests drive it exactly like the daemon does — no
 * HTTP, no clock — so a broken transition fails loudly and instantly.
 */
type TimerState = typeof timer.initialState;
type Timer = TimerState["timers"][number];

function harness() {
  const state: TimerState = structuredClone(timer.initialState);
  let emits = 0;
  const ctx: AppletCtx<TimerState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => timer.verbs[verb]!(args, ctx),
    tick: () => timer.tick!(ctx),
    init: () => timer.init!(ctx),
    at: (i: number) => state.timers[i]!,
    sel: () => state.timers[state.cursor]!,
  };
}

test("start appends a timer, selects it, and emits", () => {
  const h = harness();
  const res = h.call("start", { seconds: 90, label: "tea" }) as { id: string; running: boolean };
  expect(h.state.timers).toHaveLength(1);
  expect(h.at(0)).toMatchObject({ remaining: 90, total: 90, running: true, label: "tea" });
  expect(h.state.cursor).toBe(0);
  expect(res.id).toBe(h.at(0).id);
  expect(res.running).toBe(true);
  expect(h.emits()).toBe(1);
});

test("start parses human durations", () => {
  const h = harness();
  h.call("start", { seconds: "5m" });
  expect(h.sel().remaining).toBe(300);
  h.call("start", { seconds: "1h30m" });
  expect(h.sel().remaining).toBe(5400);
  expect(h.state.timers).toHaveLength(2); // each start is a NEW countdown
});

test("start with zero duration does not run", () => {
  const h = harness();
  h.call("start", { seconds: 0 });
  expect(h.sel().running).toBe(false);
});

test("several timers run at once; tick decrements every running one", () => {
  const h = harness();
  h.call("start", { seconds: 3, label: "tea" });
  h.call("start", { seconds: 10, label: "pasta" });
  h.call("pause", { label: "pasta" });
  h.call("start", { seconds: 2, label: "eggs" });

  h.tick();
  expect(h.at(0).remaining).toBe(2); // running
  expect(h.at(1).remaining).toBe(10); // paused — frozen
  expect(h.at(2).remaining).toBe(1); // running

  h.tick();
  expect(h.at(0).remaining).toBe(1);
  expect(h.at(2)).toMatchObject({ remaining: 0, running: false }); // finished alone
  expect(h.at(0).running).toBe(true); // ...without touching its neighbours
});

test("a tick with nothing running is a no-op", () => {
  const h = harness();
  h.call("start", { seconds: 5 });
  h.call("pause");
  const before = h.emits();
  h.tick();
  expect(h.at(0).remaining).toBe(5);
  expect(h.emits()).toBe(before);
});

test("verbs act on the selected timer by default", () => {
  const h = harness();
  h.call("start", { seconds: 10, label: "a" });
  h.call("start", { seconds: 20, label: "b" }); // selects b
  h.call("toggle");
  expect(h.at(1).running).toBe(false);
  expect(h.at(0).running).toBe(true); // untouched
  h.call("toggle");
  expect(h.at(1).running).toBe(true);
  h.call("add", { seconds: 60 });
  expect(h.at(1)).toMatchObject({ remaining: 80, total: 80 });
  expect(h.at(0).total).toBe(10);
});

test("an agent can address any timer by id, label, or index", () => {
  const h = harness();
  const a = h.call("start", { seconds: 10, label: "tea" }) as { id: string };
  h.call("start", { seconds: 20, label: "pasta" }); // selection is now pasta

  h.call("pause", { id: a.id });
  expect(h.at(0).running).toBe(false);
  h.call("resume", { label: "tea" });
  expect(h.at(0).running).toBe(true);
  h.call("add", { index: 0, seconds: 5 });
  expect(h.at(0).remaining).toBe(15);
  expect(h.at(1).remaining).toBe(20); // the selection never moved
});

test("resume only runs when time remains", () => {
  const h = harness();
  h.call("start", { seconds: 10 });
  h.call("pause");
  h.tick();
  expect(h.sel().remaining).toBe(10); // frozen
  h.call("resume");
  expect(h.sel().running).toBe(true);
  h.call("start", { seconds: 0, label: "empty" });
  h.call("resume");
  expect(h.sel().running).toBe(false); // nothing to resume
});

test("stop removes one timer; stop all empties the list", () => {
  const h = harness();
  h.call("start", { seconds: 10, label: "a" });
  h.call("start", { seconds: 20, label: "b" });
  h.call("start", { seconds: 30, label: "c" });

  h.call("stop"); // the selected one (c)
  expect(h.state.timers.map((t: Timer) => t.label)).toEqual(["a", "b"]);
  expect(h.state.cursor).toBe(1); // clamped onto b

  h.call("stop", { label: "a" });
  expect(h.state.timers.map((t: Timer) => t.label)).toEqual(["b"]);
  expect(h.state.cursor).toBe(0);

  h.call("start", { seconds: 5 });
  expect(h.call("stop", { all: true })).toMatchObject({ removed: 2 });
  expect(h.state.timers).toEqual([]);
});

test("clear drops only the finished timers", () => {
  const h = harness();
  h.call("start", { seconds: 1, label: "done" });
  h.call("start", { seconds: 60, label: "live" });
  h.tick();
  h.tick(); // "done" hits zero (and "live" keeps counting)
  expect(h.at(0)).toMatchObject({ remaining: 0, running: false });

  expect(h.call("clear")).toMatchObject({ removed: 1 });
  expect(h.state.timers.map((t: Timer) => t.label)).toEqual(["live"]);
});

test("label renames a timer without restarting it", () => {
  const h = harness();
  h.call("start", { seconds: 60 });
  h.call("label", { to: "tea" });
  expect(h.sel()).toMatchObject({ label: "tea", remaining: 60, running: true });
  const id = h.sel().id;
  h.call("start", { seconds: 30, label: "pasta" });
  h.call("label", { id, to: "green tea" }); // by id, not the selection
  expect(h.at(0).label).toBe("green tea");
  expect(h.at(1).label).toBe("pasta");
});

test("start with a known id restarts that timer in place", () => {
  const h = harness();
  const a = h.call("start", { seconds: 10, label: "tea" }) as { id: string };
  h.call("start", { seconds: 30, label: "pasta" });
  h.call("start", { id: a.id, seconds: 120 });
  expect(h.state.timers).toHaveLength(2);
  expect(h.at(0)).toMatchObject({ remaining: 120, total: 120, running: true, label: "tea" });
  expect(h.state.cursor).toBe(0); // restarting selects it
});

test("up/down move the cursor and clamp at the ends", () => {
  const h = harness();
  h.call("start", { seconds: 10 });
  h.call("start", { seconds: 20 });
  h.call("start", { seconds: 30 }); // cursor: 2
  h.call("up");
  expect(h.state.cursor).toBe(1);
  h.call("up");
  h.call("up");
  expect(h.state.cursor).toBe(0);
  h.call("down");
  h.call("down");
  h.call("down");
  expect(h.state.cursor).toBe(2);
  h.call("select", { index: 1 });
  expect(h.state.cursor).toBe(1);
});

test("keymap exposes the 5/15/25m presets", () => {
  const presets = Object.entries(timer.keymap!).filter(([, b]) => typeof b === "object" && b.verb === "start");
  expect(presets.map(([k]) => k)).toEqual(["1", "2", "3"]);
  expect(presets.map(([, b]) => (b as unknown as { args: { seconds: number } }).args.seconds)).toEqual([300, 900, 1500]);

  // ...and the preset keys really do start a fresh countdown.
  const h = harness();
  const b = timer.keymap!["2"] as { verb: string; args: Record<string, unknown> };
  h.call(b.verb, b.args);
  expect(h.sel()).toMatchObject({ remaining: 900, running: true });
});

// walk the view tree (rows/cols nest children) and collect every node
function flatten(nodes: ReturnType<typeof timer.view>): Array<Exclude<ViewNode, string>> {
  const out: Array<Exclude<ViewNode, string>> = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return;
    out.push(n);
    if (n.kind === "row" || n.kind === "col") n.children.forEach(visit);
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(visit);
  return out;
}

test("view emits a big mm:ss hero and a status line for the selection", () => {
  const h = harness();
  h.call("start", { seconds: 65 });
  const all = flatten(timer.view(h.state));
  expect(all.find((n) => n.kind === "big")).toMatchObject({ kind: "big", text: "01:05" });
  expect(all.some((n) => n.kind === "text" && n.text.includes("running"))).toBe(true);
});

test("view lists the other timers as rows with mini bars", () => {
  const h = harness();
  h.call("start", { seconds: 120, label: "tea" });
  h.call("start", { seconds: 60, label: "pasta" });
  h.tick();

  const all = flatten(timer.view(h.state, { width: 62, height: 24 }));
  expect(all.find((n) => n.kind === "big")).toMatchObject({ text: "00:59" }); // pasta, selected
  const rows = all.filter((n) => n.kind === "text" && /█|░/.test(n.text));
  expect(rows.length).toBeGreaterThanOrEqual(2); // a row per timer, each with a bar
  expect(rows.some((n) => n.kind === "text" && n.text.includes("tea"))).toBe(true);
  expect(rows.some((n) => n.kind === "text" && n.text.includes("pasta"))).toBe(true);
  // the selected row is the focus target the host scrolls to
  expect(rows.filter((n) => n.kind === "text" && n.focus)).toHaveLength(1);
});

test("view prompts for a preset when there are no timers", () => {
  const h = harness();
  const all = flatten(timer.view(h.state));
  expect(all.some((n) => n.kind === "text" && n.text.includes("no timers"))).toBe(true);
  expect(all.some((n) => n.kind === "text" && n.text.includes("5m"))).toBe(true);
});

// Roles, not hexes: the timer paints from the central theme, so this asserts
// the state -> role mapping over the SELECTED timer and stays true under any palette.
test("accent color tracks the selected timer", () => {
  const t = theme();
  const h = harness();
  expect(timer.accent!(h.state)).toBe(t.muted); // idle: nothing to show
  h.call("start", { seconds: 30 });
  expect(timer.accent!(h.state)).toBe(t.ok); // running
  h.call("pause");
  expect(timer.accent!(h.state)).toBe(t.warn); // paused
  h.call("start", { seconds: 1, label: "x" });
  h.tick();
  expect(timer.accent!(h.state)).toBe(t.error); // done
});

test("init folds a persisted v0 countdown into the list", () => {
  const h = harness();
  // what the old single-countdown state looked like on disk
  Object.assign(h.state, { remaining: 42, total: 60, running: true, label: "tea" });
  h.init();
  expect(h.state.timers).toHaveLength(1);
  expect(h.at(0)).toMatchObject({ remaining: 42, total: 60, running: true, label: "tea" });
  expect(h.state).not.toHaveProperty("remaining");

  // a stopped v0 countdown migrates to nothing at all
  const h2 = harness();
  Object.assign(h2.state, { remaining: 0, total: 0, running: false, label: "" });
  h2.init();
  expect(h2.state.timers).toEqual([]);
  expect(h2.state).not.toHaveProperty("running");
});

// --- pomodoro mode -----------------------------------------------------------
//
// The cycle is the same reducer discipline as the countdowns: verbs and tick
// move one state slice, and the view reads it. These drive short phases so a
// whole cycle fits in a handful of ticks.

/** A session with tiny phases: work 2s, short 1s, long 3s, long every 2nd. */
function pomo(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  return h.call("pomodoro.start", { work: "2s", short: "1s", long: "3s", every: 2, ...over });
}

test("pomodoro.start opens a work phase on the default plan", () => {
  const h = harness();
  const res = h.call("pomodoro.start") as { phase: string; remaining: number; rounds: number };
  expect(res).toMatchObject({ active: true, phase: "work", round: 1, running: true });
  expect(h.state.pomodoro).toMatchObject({ remaining: 1500, total: 1500 }); // 25m
  expect(res.rounds).toBe(4); // long break every 4th
  expect(h.state.timers).toEqual([]); // the plain countdowns are untouched
});

test("a work phase that runs out banks a pomodoro and rolls into the break", () => {
  const h = harness();
  pomo(h);
  h.tick();
  expect(h.state.pomodoro).toMatchObject({ phase: "work", remaining: 1 });
  h.tick();
  expect(h.state.pomodoro).toMatchObject({
    phase: "short",
    remaining: 1,
    total: 1,
    running: true, // auto-advance is the default
    completed: 1,
  });
});

test("the cycle runs work → short → work → long → work", () => {
  const h = harness();
  pomo(h); // long break every 2nd work phase
  const phases: string[] = [];
  for (let i = 0; i < 12; i++) {
    h.tick();
    const p = h.state.pomodoro;
    if (p.remaining === p.total) phases.push(`${p.phase}${p.round}`);
  }
  expect(phases.slice(0, 4)).toEqual(["short1", "work2", "long2", "work1"]);
  expect(h.state.pomodoro.completed).toBe(3); // three work phases ran to zero in 12s
});

test("auto:false parks the next phase until you say go", () => {
  const h = harness();
  pomo(h, { auto: false });
  h.tick();
  h.tick(); // work hits zero
  expect(h.state.pomodoro).toMatchObject({ phase: "short", running: false, awaiting: true });

  const before = h.state.pomodoro.remaining;
  h.tick();
  expect(h.state.pomodoro.remaining).toBe(before); // parked, not counting

  h.call("pomodoro.resume");
  expect(h.state.pomodoro).toMatchObject({ running: true, awaiting: false });
  h.tick();
  expect(h.state.pomodoro.phase).toBe("work"); // and on it goes
});

test("skip moves to the next phase without banking a pomodoro", () => {
  const h = harness();
  pomo(h);
  h.call("pomodoro.skip");
  expect(h.state.pomodoro).toMatchObject({ phase: "short", running: true, completed: 0 });
  h.call("pomodoro.skip"); // "skip this break"
  expect(h.state.pomodoro).toMatchObject({ phase: "work", round: 2, completed: 0 });
});

test("pause/resume and toggle drive one session", () => {
  const h = harness();
  pomo(h);
  h.call("pomodoro.pause");
  expect(h.state.pomodoro.running).toBe(false);
  h.tick();
  expect(h.state.pomodoro.remaining).toBe(2); // frozen
  h.call("pomodoro.resume");
  expect(h.state.pomodoro.running).toBe(true);

  h.call("pomodoro.toggle");
  expect(h.state.pomodoro.running).toBe(false); // toggle pauses a running session
  h.call("pomodoro.toggle");
  expect(h.state.pomodoro.running).toBe(true); // ...and resumes a paused one
});

test("toggle starts a session when none is on; stop ends it but keeps the tally", () => {
  const h = harness();
  h.call("pomodoro.toggle");
  expect(h.state.pomodoro).toMatchObject({ active: true, phase: "work", running: true });

  pomo(h);
  h.tick();
  h.tick(); // one banked
  expect(h.call("pomodoro.stop")).toMatchObject({ active: false, status: "off", completed: 1 });
  h.tick();
  expect(h.state.pomodoro.remaining).toBe(0); // nothing left counting
  expect(h.state.pomodoro.completed).toBe(1); // you did do that one
});

test("a pomodoro and the plain countdowns tick side by side", () => {
  const h = harness();
  h.call("start", { seconds: 10, label: "tea" });
  pomo(h);
  h.tick();
  expect(h.at(0).remaining).toBe(9);
  expect(h.state.pomodoro.remaining).toBe(1);
});

test("keymap binds the pomodoro keys, with skip/stop gated on a live session", () => {
  const h = harness();
  const bind = (k: string) => timer.keymap![k] as { verb: string; when?: (s: TimerState) => boolean };
  expect(bind("p").verb).toBe("pomodoro.toggle");
  expect(bind("n").verb).toBe("pomodoro.skip");
  expect(bind("n").when!(h.state)).toBe(false); // nothing to skip yet
  pomo(h);
  expect(bind("n").when!(h.state)).toBe(true);
  expect(bind("x").when!(h.state)).toBe(true);
});

test("the view leads with the session: phase, round, and today's count", () => {
  const h = harness();
  pomo(h);
  h.call("start", { seconds: 60, label: "tea" });
  const all = flatten(timer.view(h.state, { width: 62, height: 30 }));
  expect(all.find((n) => n.kind === "big")).toMatchObject({ text: "00:02" }); // the pomodoro, not the timer
  const lines = all.filter((n) => n.kind === "text").map((n) => n.text);
  expect(lines.some((t) => t.includes("pomodoro") && t.includes("work"))).toBe(true);
  expect(lines.some((t) => t.includes("round 1/2"))).toBe(true);
  expect(lines.some((t) => t.includes("0 done today"))).toBe(true);
  expect(lines.some((t) => t.includes("tea"))).toBe(true); // ...and the roster below it
});

test("accent follows the phase: work accent, break ok, paused warn", () => {
  const t = theme();
  const h = harness();
  pomo(h);
  expect(timer.accent!(h.state)).toBe(t.accent); // work
  h.call("pomodoro.skip");
  expect(timer.accent!(h.state)).toBe(t.ok); // break
  h.call("pomodoro.pause");
  expect(timer.accent!(h.state)).toBe(t.warn);
  h.call("pomodoro.stop");
  h.call("start", { seconds: 30 });
  expect(timer.accent!(h.state)).toBe(t.ok); // back to the selected countdown
});

test("init grows a pomodoro slice onto state persisted before the mode existed", () => {
  const h = harness();
  delete (h.state as Partial<TimerState>).pomodoro;
  h.init();
  expect(h.state.pomodoro).toMatchObject({ active: false, phase: "work", round: 1 });
  expect(h.state.pomodoro.plan.work).toBe(1500);
});

test("today's tally resets when the day turns over", () => {
  const h = harness();
  pomo(h);
  h.tick();
  h.tick();
  expect(h.state.pomodoro.completed).toBe(1);
  h.state.pomodoro.day = "1999-12-31"; // as if the daemon ran through midnight
  h.init();
  expect(h.state.pomodoro.completed).toBe(0);
});
