import { test, expect } from "bun:test";
import applet from "./index.ts";
import type { AppletCtx } from "../../sdk/index.ts";

/**
 * The rules, driven exactly as the daemon drives them: a verb (or a tick) over
 * a state object. No terminal, no HTTP — the game is a reducer.
 */

type State = typeof applet.initialState;

/** A fresh state plus whatever this test cares about, and a ctx over it. */
function game(over: Partial<State> = {}): { state: State; ctx: AppletCtx<State>; emits: () => number } {
  const state = { ...structuredClone(applet.initialState), ...over } as State;
  let emits = 0;
  return { state, ctx: { state, emit: () => void emits++ }, emits: () => emits };
}

const call = (verb: string, args: Record<string, unknown>, ctx: AppletCtx<State>) =>
  applet.verbs[verb]!(args, ctx);

/** The tick, as the daemon fires it. */
const tick = (ctx: AppletCtx<State>) => applet.tick!(ctx);

test("a new game deals a snake, food and a running clock", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 7 }, ctx);
  expect(state.status).toBe("running");
  expect(state.snake.length).toBe(4);
  expect(state.score).toBe(0);
  // Food never lands under the snake.
  expect(state.snake.some((p) => p.x === state.food.x && p.y === state.food.y)).toBe(false);
});

test("a seed replays the same game", () => {
  const a = game();
  const b = game();
  call("newGame", { seed: 42 }, a.ctx);
  call("newGame", { seed: 42 }, b.ctx);
  call("step", { n: 20 }, a.ctx);
  call("step", { n: 20 }, b.ctx);
  expect(a.state.snake).toEqual(b.state.snake);
  expect(a.state.food).toEqual(b.state.food);
});

test("step moves the head one cell in the current direction", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 1 }, ctx);
  const head = state.snake[0]!;
  call("step", {}, ctx);
  expect(state.snake[0]).toEqual({ x: head.x + 1, y: head.y });
});

test("turning steers the next step, and a fold back into the neck is refused", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 1 }, ctx); // heading right
  expect((call("turn", { dir: "left" }, ctx) as { took: boolean }).took).toBe(false);
  expect((call("turn", { dir: "up" }, ctx) as { took: boolean }).took).toBe(true);
  call("step", {}, ctx);
  expect(state.dir).toBe("up");
});

test("two turns inside one step both land, in order", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 1 }, ctx);
  call("turn", { dir: "up" }, ctx);
  call("turn", { dir: "left" }, ctx); // valid against the queued `up`, not against `right`
  expect(state.turns).toEqual(["up", "left"]);
  call("step", {}, ctx);
  expect(state.dir).toBe("up");
  call("step", {}, ctx);
  expect(state.dir).toBe("left");
});

test("eating grows the snake and scores; the food moves on", () => {
  const { state, ctx } = game({
    status: "paused",
    snake: [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
    ],
    dir: "right",
    food: { x: 6, y: 5 },
  });
  call("step", {}, ctx);
  expect(state.score).toBe(10);
  expect(state.snake.length).toBe(3);
  expect(state.food).not.toEqual({ x: 6, y: 5 });
});

test("a wall is the end of the game, and the high score keeps the number", () => {
  const { state, ctx } = game({
    status: "paused",
    snake: [{ x: 15, y: 5 }],
    dir: "right",
    score: 90,
    food: { x: 0, y: 0 },
  });
  call("step", {}, ctx);
  expect(state.status).toBe("over");
  expect(state.best).toBe(90);
  // ...and a fresh board keeps it.
  call("newGame", {}, ctx);
  expect(state.best).toBe(90);
  expect(state.score).toBe(0);
});

test("biting yourself is fatal, but the cell the tail is leaving is not", () => {
  const ring = [
    { x: 5, y: 5 },
    { x: 5, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: 5 },
  ];
  // Down into its own second cell: fatal.
  const bite = game({ status: "paused", snake: ring, dir: "left", food: { x: 0, y: 0 } });
  call("turn", { dir: "down" }, bite.ctx);
  call("step", {}, bite.ctx);
  expect(bite.state.status).toBe("over");

  // Right onto the cell the tail vacates this very step: legal.
  const chase = game({ status: "paused", snake: ring, dir: "up", food: { x: 0, y: 0 } });
  call("turn", { dir: "right" }, chase.ctx);
  call("step", {}, chase.ctx);
  expect(chase.state.status).toBe("paused");
  expect(chase.state.snake[0]).toEqual({ x: 6, y: 5 });
});

test("a paused game moves only when an agent steps it", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 3 }, ctx);
  call("pause", {}, ctx);
  const head = { ...state.snake[0]! };
  for (let i = 0; i < 40; i++) tick(ctx); // the clock runs; the world does not
  expect(state.snake[0]).toEqual(head);
  call("step", {}, ctx);
  expect(state.snake[0]).not.toEqual(head);
  expect(state.status).toBe("paused"); // stepping never resumes the clock
});

test("the tick moves the snake on its own, at the pace of the speed ladder", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 5 }, ctx);
  const head = { ...state.snake[0]! };
  tick(ctx);
  expect(state.snake[0]).toEqual(head); // one tick is not one step
  for (let i = 0; i < 8; i++) tick(ctx);
  expect(state.snake[0]).not.toEqual(head);
});

test("turning on the loader screen starts the game — the joystick is the start button", () => {
  const { state, ctx } = game({ status: "ready" });
  call("turn", { dir: "up" }, ctx);
  expect(state.status).toBe("running");
  expect(state.snake.length).toBe(4);
});

test("...but turning a PAUSED game leaves it paused, so an agent keeps the clock", () => {
  const { state, ctx } = game();
  call("newGame", { seed: 3 }, ctx);
  call("pause", {}, ctx);
  call("turn", { dir: "up" }, ctx);
  expect(state.status).toBe("paused");
  expect(state.turns).toEqual(["up"]);
});

test("the loader runs itself, then stops at READY.", () => {
  const { state, ctx } = game();
  expect(state.status).toBe("boot");
  for (let i = 0; i < 200; i++) tick(ctx);
  expect(state.status).toBe("ready");
  // A screen nobody is playing costs nothing: no more repaints once it settles.
  const before = state.frame;
  tick(ctx);
  expect(state.frame).toBe(before);
});

test("a game that was running when the daemon stopped comes back paused", () => {
  const { state, ctx } = game({ status: "running", snake: [{ x: 5, y: 5 }] });
  applet.init!(ctx);
  expect(state.status).toBe("paused");
});

test("turn refuses a direction that isn't one", () => {
  const { ctx } = game({ status: "running", snake: [{ x: 5, y: 5 }] });
  expect(() => call("turn", { dir: "sideways" }, ctx)).toThrow(/up\/down\/left\/right/);
});
