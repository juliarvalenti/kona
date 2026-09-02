import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The board is drawn as filled cells, so these fixtures pin the NUMBERS and the
 * furniture around them — the colors are theme roles and belong to the palette,
 * not to this applet.
 */

/** A board a few hundred moves in, which is what 2048 looks like when it's fun. */
const midGame = {
  grid: [2, 8, 32, 4, 16, 128, 64, 2, 4, 32, 512, 256, 0, 4, 16, 8],
  score: 6420,
  best: 21040,
  bestTile: 512,
  moves: 217,
  status: "playing",
  spawned: 7,
  seed: 7,
};

export default defineSnapshots([
  {
    name: "a board mid-game, with the score as a hero beside it",
    hero: true,
    state: midGame,
    // The gallery's window, so this fixture asserts on the frame it ships.
    width: 80,
    height: 24,
    contains: ["512", "128", "SCORE", "BEST     21040", "TILE     512", "MOVES    217"],
  },
  {
    name: "a narrow terminal keeps the board and drops the hero",
    state: midGame,
    width: 62,
    contains: ["SCORE 6420   BEST 21040   TILE 512", "512"],
    excludes: ["MOVES    217"], // the panel is gone, not squeezed
  },
  {
    name: "reaching the goal is a milestone, not an ending",
    state: { ...midGame, grid: [2048, 8, 32, 4, 16, 128, 64, 2, 4, 32, 512, 256, 0, 4, 16, 8], status: "won" },
    width: 80,
    height: 24,
    contains: ["2048! AND STILL PLAYING"],
    excludes: ["GAME OVER"],
  },
  {
    name: "a dead board says so across the middle of itself",
    state: {
      ...midGame,
      grid: [2, 8, 32, 4, 16, 128, 64, 2, 4, 32, 512, 256, 16, 4, 16, 8],
      status: "over",
    },
    width: 80,
    height: 24,
    contains: ["GAME OVER", "NO MOVES LEFT — N TO DEAL AGAIN"],
  },
]);
