import { test, expect } from "bun:test";
import type { AppletCtx } from "../../sdk/index.ts";
import applet from "./index.ts";

/**
 * 2048 is a turn-based reducer: a verb in, a board out. Every spawn goes
 * through the state's own seed, so these run the same game every time — the
 * property that makes the applet worth handing to an agent in the first place.
 */

type State = typeof applet.initialState;

function game(over: Partial<State> = {}) {
  const state = { ...structuredClone(applet.initialState), ...over } as State;
  let emits = 0;
  const ctx: AppletCtx<State> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => applet.verbs[verb]!(args, ctx),
    init: () => applet.init!(ctx),
  };
}

/** A row-major grid, written the way it looks on screen. */
const grid = (...rows: number[][]) => rows.flat();

test("a new board is two tiles and nothing else", () => {
  const g = game();
  g.call("newGame", { seed: 7 });
  expect(g.state.grid.filter((v) => v !== 0)).toHaveLength(2);
  expect(g.state.grid.every((v) => v === 0 || v === 2 || v === 4)).toBe(true);
  expect(g.state.score).toBe(0);
});

test("first boot deals a board rather than showing an empty one", () => {
  const g = game();
  g.init();
  expect(g.state.grid.filter((v) => v !== 0)).toHaveLength(2);
});

test("a pair merges once per move, not twice", () => {
  const g = game({
    grid: grid([2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    seed: 1,
  });
  g.call("left");
  // 2 2 2 2 -> 4 4, never 8. The rest of the row is free, so only a spawn is
  // there, and a spawn is never a 4 next to a 4 it just made.
  expect(g.state.grid.slice(0, 2)).toEqual([4, 4]);
  expect(g.state.score).toBe(8);
  expect(g.state.moves).toBe(1);
});

test("tiles slide the whole way, and the direction is the direction", () => {
  const g = game({ grid: grid([0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), seed: 1 });
  g.call("left");
  expect(g.state.grid[0]).toBe(2);

  const down = game({ grid: grid([2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), seed: 1 });
  down.call("down");
  expect(down.state.grid[12]).toBe(2);
});

test("a move that changes nothing is not a move: no tile, no count, no score", () => {
  const before = grid([2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  const g = game({ grid: before.slice(), seed: 1 });
  const res = g.call("left") as { moved: boolean };
  expect(res.moved).toBe(false);
  expect(g.state.grid).toEqual(before);
  expect(g.state.moves).toBe(0);
});

test("the goal tile is a milestone, and the board plays on past it", () => {
  const g = game({
    grid: grid([1024, 1024, 0, 0], [2, 4, 8, 16], [4, 8, 16, 32], [8, 16, 32, 64]),
    seed: 1,
  });
  g.call("left");
  expect(g.state.grid[0]).toBe(2048);
  expect(g.state.status).toBe("won");
  expect(g.state.bestTile).toBe(2048);
  expect(g.state.score).toBe(2048);
});

test("a board with nowhere left to slide is over", () => {
  const g = game({
    grid: grid([2, 4, 8, 16], [32, 64, 128, 256], [4, 8, 16, 32], [0, 2, 4, 8]),
    seed: 1,
  });
  g.call("left"); // the bottom row shuffles left; the spawn fills the last cell
  expect(g.state.grid.includes(0)).toBe(false);
  expect(g.state.status).toBe("over");
  // ...and the board stops answering.
  expect((g.call("up") as { moved: boolean }).moved).toBe(false);
});

test("the high score outlives the board", () => {
  const g = game({ grid: grid([2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), seed: 1 });
  g.call("left");
  expect(g.state.best).toBe(4);
  g.call("newGame");
  expect(g.state.score).toBe(0);
  expect(g.state.best).toBe(4);
});

test("the same seed plays the same game", () => {
  const a = game();
  const b = game();
  a.call("newGame", { seed: 99 });
  b.call("newGame", { seed: 99 });
  a.call("auto", { moves: 60 });
  b.call("auto", { moves: 60 });
  expect(a.state.grid).toEqual(b.state.grid);
  expect(a.state.score).toBe(b.state.score);
  expect(a.state.moves).toBe(b.state.moves);
});

test("auto plays the board and stops when the board does", () => {
  const g = game();
  g.call("newGame", { seed: 5 });
  const res = g.call("auto", { moves: 500 }) as { played: number; status: string; tile: number };
  expect(res.played).toBeGreaterThan(20);
  expect(res.tile).toBeGreaterThanOrEqual(64);
  // 500 greedy moves finish a game; a finished game plays no further.
  if (res.status === "over") expect((g.call("auto", { moves: 10 }) as { played: number }).played).toBe(0);
});

test("move names a direction, and refuses one that isn't", () => {
  const g = game({ grid: grid([0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), seed: 1 });
  g.call("move", { dir: "left" });
  expect(g.state.grid[0]).toBe(2);
  expect(() => g.call("move", { dir: "sideways" })).toThrow(/left\/right\/up\/down/);
});

test("every move emits, so the TUI repaints — after the board has moved", () => {
  const g = game({ grid: grid([2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), seed: 1 });
  g.call("left");
  expect(g.emits()).toBe(1);
});

test("the config sample parses — an all-digit id has to be quoted in TOML", () => {
  const doc = Bun.TOML.parse(applet.configSample!) as { applets?: Record<string, unknown> };
  expect(doc.applets?.[applet.id]).toEqual({ goal: 2048 });
});
