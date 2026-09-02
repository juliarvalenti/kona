import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The frames worth pinning: the game being played (the portrait), the C64
 * loader it boots through, and the two screens that are only ever a banner
 * over a frozen board.
 */

/** A snake mid-turn, the way the hero should find it. */
const playing = {
  status: "running",
  snake: [
    { x: 9, y: 4 },
    { x: 8, y: 4 },
    { x: 7, y: 4 },
    { x: 6, y: 4 },
    { x: 6, y: 5 },
    { x: 6, y: 6 },
    { x: 5, y: 6 },
    { x: 4, y: 6 },
  ],
  dir: "right",
  turns: [],
  food: { x: 12, y: 2 },
  score: 240,
  best: 450,
  eaten: 24,
  frame: 0,
  seed: 7,
};

export default defineSnapshots([
  {
    name: "a game in play: board, snake, food and the score as a hero",
    hero: true,
    state: playing,
    // The gallery's window, so this fixture asserts on the frame it ships.
    width: 80,
    height: 24,
    contains: [
      "██", // the head
      "▓▓", // ...and the body behind it
      "◆◆", // supper
      "SCORE",
      "HI      0450",
      "LENGTH    08",
      "RUNNING",
    ],
  },
  {
    name: "a narrow terminal drops the panel for one score line",
    state: playing,
    width: 62,
    contains: ["SCORE 0240   HI 0450   LEN 8", "◆◆"],
    excludes: ["LENGTH"], // the side panel is gone, not squeezed
  },
  {
    name: "the tape loads a line at a time before it will let you play",
    state: { status: "boot", frame: 32 },
    width: 80,
    height: 24,
    contains: ["**** COMMODORE 64 BASIC V2 ****", 'LOAD"SNAKE",8,1', "▮", "LOADING…"],
    excludes: ["SEARCHING FOR SNAKE", "PRESS SPACE"], // the tape is still running
  },
  {
    name: "READY. waits for the space bar",
    state: { status: "ready" },
    width: 80,
    height: 24,
    contains: ["READY.", "SEARCHING FOR SNAKE", "▮ PRESS SPACE TO PLAY"],
  },
  {
    name: "a pause is a banner over the board, not a screen of its own",
    state: { ...playing, status: "paused" },
    width: 80,
    height: 24,
    contains: ["PAUSED", "◆◆", "SPACE TO GO ON"],
  },
  {
    name: "game over freezes the board and asks for another quarter",
    state: { ...playing, status: "over", score: 1230, best: 1230 },
    width: 80,
    height: 24,
    contains: ["GAME OVER", "PRESS N TO PLAY AGAIN", "HI      1230"],
  },
]);
