import { test, expect } from "bun:test";
import type { AppletCtx } from "../sdk/index.ts";
import timer from "../applets/timer/index.ts";

/**
 * The timer applet is a pure reducer over its state: verbs and tick mutate the
 * same state and emit. These tests drive it exactly like the daemon does — no
 * HTTP, no clock — so a broken transition fails loudly and instantly.
 */
type TimerState = typeof timer.initialState;

function harness() {
  const state: TimerState = structuredClone(timer.initialState);
  let emits = 0;
  const ctx: AppletCtx<TimerState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => timer.verbs[verb]!(args, ctx),
    tick: () => timer.tick!(ctx),
  };
}

test("start sets remaining + running and emits", () => {
  const h = harness();
  h.call("start", { seconds: 90, label: "tea" });
  expect(h.state.remaining).toBe(90);
  expect(h.state.running).toBe(true);
  expect(h.state.label).toBe("tea");
  expect(h.emits()).toBe(1);
});

test("start parses human durations", () => {
  const h = harness();
  h.call("start", { seconds: "5m" });
  expect(h.state.remaining).toBe(300);
  h.call("start", { seconds: "1h30m" });
  expect(h.state.remaining).toBe(5400);
});

test("start with zero duration does not run", () => {
  const h = harness();
  h.call("start", { seconds: 0 });
  expect(h.state.running).toBe(false);
});

test("tick counts down and stops at zero", () => {
  const h = harness();
  h.call("start", { seconds: 2 });
  h.tick();
  expect(h.state.remaining).toBe(1);
  expect(h.state.running).toBe(true);
  h.tick();
  expect(h.state.remaining).toBe(0);
  expect(h.state.running).toBe(false);
  // a tick past zero is a no-op
  const before = h.emits();
  h.tick();
  expect(h.state.remaining).toBe(0);
  expect(h.emits()).toBe(before);
});

test("pause freezes; resume only runs when time remains", () => {
  const h = harness();
  h.call("start", { seconds: 10 });
  h.call("pause");
  expect(h.state.running).toBe(false);
  h.tick();
  expect(h.state.remaining).toBe(10); // frozen
  h.call("resume");
  expect(h.state.running).toBe(true);
  h.call("stop");
  h.call("resume"); // nothing to resume
  expect(h.state.running).toBe(false);
});

test("toggle flips running; add extends; stop resets", () => {
  const h = harness();
  h.call("start", { seconds: 10 });
  h.call("toggle");
  expect(h.state.running).toBe(false);
  h.call("toggle");
  expect(h.state.running).toBe(true);
  h.call("add", { seconds: 60 });
  expect(h.state.remaining).toBe(70);
  h.call("stop");
  expect(h.state).toMatchObject({ remaining: 0, running: false, label: "" });
});

test("view emits a big mm:ss hero and a status line", () => {
  const h = harness();
  h.call("start", { seconds: 65 });
  const nodes = timer.view(h.state);
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  const big = arr.find((n) => typeof n === "object" && n.kind === "big");
  expect(big).toMatchObject({ kind: "big", text: "01:05" });
  const hasStatus = arr.some((n) => typeof n === "object" && n.kind === "text" && n.text.includes("running"));
  expect(hasStatus).toBe(true);
});

test("accent color tracks timer state", () => {
  const h = harness();
  expect(timer.accent!(h.state)).toBe("#5a5a5a"); // idle
  h.call("start", { seconds: 30 });
  expect(timer.accent!(h.state)).toBe("#00d488"); // running
  h.call("pause");
  expect(timer.accent!(h.state)).toBe("#f0b000"); // paused
});
