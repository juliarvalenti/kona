import {
  appletBool,
  appletString,
  big,
  box,
  col,
  row,
  text,
  theme,
  defineApplet,
  fitBigFont,
  type Color,
  type Theme,
  type ViewNode,
} from "../../sdk/index.ts";
import { notify } from "../../server/notify.ts";

/**
 * snake — the C64 hero.
 *
 * The board is not a new primitive: it is a `col` of `row`s of colored `text`
 * cells, which is all the view vocabulary a game turns out to need. The daemon's
 * `tick` is the game loop, state is the world, and `keymap` is the joystick.
 *
 * Real-time games do NOT travel well over HTTP — an agent reads a frame the
 * tick has already moved past — so the agent story here is deliberately modest:
 * `kona state snake` spectates, and a PAUSED game still answers `step`, which
 * turns the loop turn-by-turn for as long as the caller wants it. No pacing
 * mode to configure, no promise of 10fps play: pause, then step.
 */

/** Cells across and down. The board is state, not layout — the rules need it. */
const W = 16;
const H = 12;
/** Chars per cell. Two, so a cell is roughly square in a terminal. */
const CELL = 2;
/** The board with its frame, the gutter, and what is left for the score panel. */
const BOARD_W = W * CELL + 2;
const GAP = 2;
const PANEL_W = 37;

const POINTS = 10;
/** Ticks between steps, fastest last. Eating enough food moves you along it. */
const SPEEDS = [5, 4, 3, 2];
/** Food eaten per speed step. */
const PER_LEVEL = 5;
/** Ticks each line of the loader screen holds for. */
const BOOT_TICKS = 4;

type Dir = "up" | "down" | "left" | "right";
type Status = "boot" | "ready" | "running" | "paused" | "over";

interface Pt {
  x: number;
  y: number;
}

interface SnakeState {
  status: Status;
  /** Head first. Its length IS the snake's length. */
  snake: Pt[];
  /** The direction the last step took. */
  dir: Dir;
  /**
   * Turns taken but not yet stepped, oldest first. A queue rather than a single
   * field so an up-then-left flick inside one step lands both turns instead of
   * dropping the second — and validating each against the one before it is what
   * keeps a fast pair from folding the snake back into itself.
   */
  turns: Dir[];
  food: Pt;
  score: number;
  /** The high score. State is persisted, so this outlives the daemon. */
  best: number;
  eaten: number;
  /** Ticks since the last step — also the loader's clock while booting. */
  frame: number;
  /** The LCG behind food placement. Set it and the same game plays out twice. */
  seed: number;
}

const DELTA: Record<Dir, Pt> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
const isDir = (v: unknown): v is Dir => typeof v === "string" && v in DELTA;

/**
 * The loader. A C64 did not start a game, it LOADED one — so this one does too,
 * a line at a time off tape, before it will let you play.
 */
const LOADER = [
  "",
  " **** COMMODORE 64 BASIC V2 ****",
  "",
  "  64K RAM SYSTEM 38911 BASIC",
  "        BYTES FREE",
  "",
  "READY.",
  'LOAD"SNAKE",8,1',
  "SEARCHING FOR SNAKE",
  "LOADING",
  "READY.",
];

/** A number the way an arcade shows one: four digits, leading zeroes and all. */
const pad4 = (n: number) => String(Math.min(n, 9999)).padStart(4, "0");

/** How far along the speed ladder this game has climbed. */
const level = (s: SnakeState) => Math.min(SPEEDS.length - 1, Math.floor(s.eaten / PER_LEVEL));
const stepTicks = (s: SnakeState) => SPEEDS[level(s)]!;

/**
 * One draw from the game's own random number generator (an LCG over `seed`).
 * Food placement is the only thing in here that is not a pure function of the
 * keys pressed, so it goes through state: a fixture — or an agent chasing a bug
 * — replays the exact same game by starting from the same seed.
 */
function rand(state: SnakeState): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

/** A free cell for the next piece of food, or the old one if the board is full. */
function placeFood(state: SnakeState): Pt {
  const taken = new Set(state.snake.map((p) => p.y * W + p.x));
  const free: number[] = [];
  for (let i = 0; i < W * H; i++) if (!taken.has(i)) free.push(i);
  const pick = free[Math.floor(rand(state) * free.length)];
  if (pick === undefined) return state.food;
  return { x: pick % W, y: Math.floor(pick / W) };
}

/** A fresh game, keeping the high score (and the seed's place in the sequence). */
function reset(state: SnakeState, seed?: number): void {
  const y = Math.floor(H / 2);
  state.snake = [
    { x: 5, y },
    { x: 4, y },
    { x: 3, y },
    { x: 2, y },
  ];
  state.dir = "right";
  state.turns = [];
  state.score = 0;
  state.eaten = 0;
  state.frame = 0;
  if (seed !== undefined) state.seed = seed >>> 0;
  state.food = placeFood(state);
  state.status = "running";
}

/**
 * Get a game moving: pick a stopped one back up, and deal a new board when the
 * last one is finished (or when there has never been one).
 */
function begin(state: SnakeState): void {
  if (state.status === "over" || state.snake.length === 0) reset(state);
  else state.status = "running";
}

/** Stop the clock, if it is running. A stopped game is still a game. */
function halt(state: SnakeState): void {
  if (state.status === "running") state.status = "paused";
}

/** Walls kill by default — the C64 way. `walls = false` wraps them instead. */
const wallsKill = () => appletBool("snake", "walls", true);

/**
 * Ticks per step at the start of a game. The speed ladder is relative to it, so
 * "slow" is slower all the way up rather than only off the line.
 */
function speedOffset(): number {
  const named = appletString("snake", "speed", "classic").toLowerCase();
  if (named === "slow") return 2;
  if (named === "fast") return -1;
  return 0;
}

/**
 * Advance the world one cell. The whole game is here: turn, move, eat or die.
 * Pure over state so a verb, the tick and a test all drive it the same way.
 * Answers whether the snake is still alive, so a caller stepping several frames
 * stops at the wall instead of walking a corpse into it.
 */
function step(state: SnakeState): boolean {
  const turn = state.turns.shift();
  if (turn) state.dir = turn;

  const head = state.snake[0]!;
  const d = DELTA[state.dir];
  let next = { x: head.x + d.x, y: head.y + d.y };

  const off = next.x < 0 || next.x >= W || next.y < 0 || next.y >= H;
  if (off) {
    if (wallsKill()) return die(state);
    next = { x: (next.x + W) % W, y: (next.y + H) % H };
  }

  const eating = next.x === state.food.x && next.y === state.food.y;
  // The tail cell is vacated by this very step, so moving into it is legal —
  // unless the snake is growing, in which case the tail stays put.
  const body = eating ? state.snake : state.snake.slice(0, -1);
  if (body.some((p) => p.x === next.x && p.y === next.y)) return die(state);

  state.snake.unshift(next);
  if (eating) {
    state.score += POINTS;
    state.eaten += 1;
    state.food = placeFood(state);
  } else {
    state.snake.pop();
  }
  return true;
}

/** Game over. A high score is the one thing here worth a desktop banner. */
function die(state: SnakeState): false {
  state.status = "over";
  state.turns = [];
  if (state.score > state.best) {
    const beaten = state.best;
    state.best = state.score;
    if (beaten > 0) {
      void notify({
        event: "snake.highscore",
        title: "NEW HIGH SCORE",
        body: `${state.score} on snake — ${beaten} stood since the last one.`,
        key: `snake.highscore:${state.score}`,
      });
    }
  }
  return false;
}

/** Take a turn if it isn't a fold back into the neck. Two may be queued. */
function turn(state: SnakeState, dir: Dir): boolean {
  if (state.turns.length >= 2) return false;
  const from = state.turns[state.turns.length - 1] ?? state.dir;
  if (dir === from || dir === OPPOSITE[from]) return false;
  state.turns.push(dir);
  return true;
}

// --- rendering: a board is a col of rows of colored text cells.

interface Cell {
  glyph: string;
  color: Color;
  dim?: boolean;
}

/**
 * One board row as the FEWEST text nodes that can draw it: neighbouring cells
 * of one color merge into a single run. A 16-wide row is two or three nodes
 * instead of sixteen, and the board is repainted on every step.
 */
function band(cells: Cell[]): ViewNode {
  const runs: Cell[] = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last.color === c.color && !!last.dim === !!c.dim) last.glyph += c.glyph;
    else runs.push({ ...c });
  }
  return row(runs.map((r) => text(r.glyph, { color: r.color, dim: r.dim })));
}

/** The playfield itself, one row of cells per board row. */
function playfield(state: SnakeState, t: Theme): ViewNode[] {
  const head = state.snake[0]!;
  const body = new Set(state.snake.slice(1).map((p) => p.y * W + p.x));
  const rows: ViewNode[] = [];
  for (let y = 0; y < H; y++) {
    const cells: Cell[] = [];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (head.x === x && head.y === y) cells.push({ glyph: "██", color: t.accent });
      else if (body.has(i)) cells.push({ glyph: "▓▓", color: t.ok });
      else if (state.food.x === x && state.food.y === y) cells.push({ glyph: "◆◆", color: t.warn });
      else cells.push({ glyph: "· ", color: t.muted, dim: true });
    }
    rows.push(band(cells));
  }
  return rows;
}

/** The loader screen, revealed a line at a time while the tape runs. */
function loading(state: SnakeState, t: Theme): ViewNode[] {
  const shown = state.status === "boot" ? Math.floor(state.frame / BOOT_TICKS) : LOADER.length;
  const lines = LOADER.slice(0, Math.min(shown, LOADER.length));
  const done = lines.length >= LOADER.length;
  const out = lines.map((l) => text(l, { color: t.ok }));
  // The cursor a C64 leaves sitting under the last line it printed.
  out.push(text(done ? "▮ PRESS SPACE TO PLAY" : "▮", { color: t.ok }));
  while (out.length < H) out.push(text(""));
  return out.slice(0, H);
}

/** A line of text laid over the middle of the board — PAUSED, GAME OVER. */
function banner(rows: ViewNode[], label: string, color: Color): ViewNode[] {
  const wide = W * CELL;
  const pad = Math.max(0, Math.floor((wide - label.length - 2) / 2));
  const out = [...rows];
  out[Math.floor(H / 2)] = text(`${" ".repeat(pad)} ${label} `, { color });
  return out;
}

/** Board box: the playfield, the loader, or the playfield with a banner over it. */
function boardBox(state: SnakeState, t: Theme): ViewNode {
  const playing = state.status === "running" || state.status === "paused" || state.status === "over";
  let rows = playing ? playfield(state, t) : loading(state, t);
  if (state.status === "paused") rows = banner(rows, "PAUSED", t.warn);
  if (state.status === "over") rows = banner(rows, "GAME OVER", t.error);
  return box(rows, {
    border: true,
    borderColor: state.status === "over" ? t.error : t.accent,
    width: BOARD_W,
  });
}

/** What the machine is doing right now, in one arcade-shouty line. */
function statusLine(state: SnakeState, t: Theme): ViewNode {
  if (state.status === "over") return text("PRESS N TO PLAY AGAIN", { color: t.error });
  if (state.status === "paused") return text("PAUSED — SPACE TO GO ON", { color: t.warn });
  if (state.status === "running") return text("RUNNING", { color: t.ok });
  if (state.status === "ready") return text("READY.", { color: t.ok });
  return text("LOADING…", { color: t.dim });
}

/**
 * The score panel — the `big` hero, with the rest of the cabinet under it.
 *
 * The hero names its own figlet, which most applets should not do: it is drawn
 * in a COLUMN beside the board, and `big` sizes itself against the whole pane,
 * so a wide theme font would be clipped by the panel rather than shrunk to it.
 * Starting from `theme().font` keeps a theme's re-lettering — it only ever
 * narrows it.
 */
function panel(state: SnakeState, t: Theme): ViewNode {
  const score = String(state.score);
  return col(
    [
      big(score, t.accent, fitBigFont(score, t.font, { width: PANEL_W, height: 6 })),
      text("SCORE", { dim: true }),
      text(""),
      text(`HI      ${pad4(state.best)}`, { color: t.alt }),
      text(`LENGTH    ${String(state.snake.length).padStart(2, "0")}`),
      text(`SPEED      ${level(state) + 1}`),
      text(""),
      statusLine(state, t),
    ],
    { gap: 0 },
  );
}

export default defineApplet<SnakeState>({
  id: "snake",
  title: "Snake",
  summary: "The C64 classic. Eat, grow, don't bite yourself.",
  icon: "§",
  tint: "#66d97a",
  labels: ["game"],
  initialState: {
    status: "boot",
    snake: [],
    dir: "right",
    turns: [],
    food: { x: 0, y: 0 },
    score: 0,
    best: 0,
    eaten: 0,
    frame: 0,
    seed: 1,
  },

  /**
   * A game that was mid-run when the daemon stopped must not resume in motion:
   * nobody is at the keyboard on boot, and the first thing an unattended snake
   * does is drive into a wall.
   */
  init({ state, emit }) {
    if (state.status === "running") state.status = "paused";
    if (state.status !== "boot" && state.snake.length === 0) reset(state, state.seed);
    emit();
  },

  verbs: {
    /** Start, or pick a paused game back up. From the loader it skips the tape. */
    start: (_args, { state, emit }) => {
      begin(state);
      emit();
      return { status: state.status, score: state.score };
    },
    /** Stop the clock. A paused game still answers `step`, one frame at a time. */
    pause: (_args, { state, emit }) => {
      halt(state);
      emit();
      return { status: state.status };
    },
    /** One key for both, because the space bar is one key: start, or stop. */
    toggle: (_args, { state, emit }) => {
      if (state.status === "running") halt(state);
      else begin(state);
      emit();
      return { status: state.status, score: state.score };
    },
    /**
     * Steer. On the loader screen the joystick is also the start button — but a
     * PAUSED game stays paused: pausing was deliberate, and an agent playing
     * turn-by-turn (pause, turn, step) must not have the clock started under it.
     */
    turn: (args, { state, emit }) => {
      if (!isDir(args.dir)) throw new Error("turn: dir must be one of up/down/left/right");
      if (state.status === "over") return { status: state.status };
      if (state.status === "boot" || state.status === "ready") begin(state);
      const took = turn(state, args.dir);
      emit();
      return { dir: state.dir, queued: state.turns, took };
    },
    /**
     * Advance the world by hand — the agent's way in. A running game moves on
     * the tick; a PAUSED one moves only here, which is real-time for a human
     * and turn-by-turn for a caller that would otherwise be reading stale
     * frames.
     */
    step: (args, { state, emit }) => {
      const n = typeof args.n === "number" ? Math.max(1, Math.min(50, Math.floor(args.n))) : 1;
      if (state.status === "boot" || state.status === "ready") {
        reset(state);
        state.status = "paused";
      }
      if (state.status === "over") return { status: state.status, score: state.score };
      for (let i = 0; i < n; i++) if (!step(state)) break;
      state.frame = 0;
      emit();
      return {
        status: state.status,
        score: state.score,
        head: state.snake[0],
        food: state.food,
        length: state.snake.length,
      };
    },
    /**
     * What the back key does here. A running game stops rather than being
     * walked away from — leaving a snake in motion is how you come back to a
     * dead one — and pressing it again, on a game that is now paused, leaves.
     * The keyboard's verb, not an agent's: `pause` is the one to call.
     */
    back: (_args, { state, emit }) => {
      halt(state);
      emit();
      return { status: state.status };
    },
    /** A new game. The high score stays; `{ "seed": 7 }` replays a known one. */
    newGame: (args, { state, emit }) => {
      reset(state, typeof args.seed === "number" ? args.seed : undefined);
      emit();
      return { status: state.status, seed: state.seed };
    },
  },

  // Nothing here leaves the machine, and a move is a move: an agent plays
  // without waiting on anyone.
  priority: { start: "low", pause: "low", toggle: "low", turn: "low", step: "low", back: "low", newGame: "low" },

  docs: {
    start: "Start a new game, or resume a paused one.",
    pause: "Stop the clock. The board keeps its state — and still answers `step`.",
    toggle: "Start a stopped game, stop a running one — what the space bar does.",
    turn: { doc: "Steer the snake. From the loader screen it also starts the game; a paused one stays paused.", args: { dir: "up" } },
    step: {
      doc: "Advance the world by hand. On a paused game this is the whole loop, one frame per call.",
      args: { n: 1 },
    },
    newGame: { doc: "Throw the board away and deal a new one. Same seed, same game.", args: { seed: 7 } },
  },

  recipes: [
    {
      title: "Watch a game without touching it",
      steps: ["kona state snake", "curl -N localhost:4177/events"],
      note: "State carries the snake, the food and the score; the stream repaints as the tick moves it.",
    },
    {
      title: "Play turn-by-turn, as an agent",
      steps: [
        "kona call snake newGame '{\"seed\":7}'",
        "kona call snake pause",
        "kona call snake turn '{\"dir\":\"up\"}'",
        "kona call snake step",
      ],
      note: "A paused game only moves when you say so, so nothing goes stale between reading the board and answering it. Repeat turn/step; `step` returns the head, the food and the score.",
    },
  ],

  tickMs: 60,
  tick({ state, emit }) {
    if (state.status === "boot") {
      state.frame += 1;
      // Only when another line of the tape has landed — a repaint per frame
      // would be twelve pointless SSE messages a second.
      if (state.frame % BOOT_TICKS === 0) {
        if (state.frame / BOOT_TICKS > LOADER.length) {
          state.status = "ready";
          state.frame = 0;
        }
        emit();
      }
      return;
    }
    // A stopped game costs nothing: no repaint, no state written to disk.
    if (state.status !== "running") return;
    state.frame += 1;
    if (state.frame < Math.max(1, stepTicks(state) + speedOffset())) return;
    state.frame = 0;
    step(state);
    emit();
  },

  view(state, ctx) {
    const t = theme();
    const board = boardBox(state, t);
    // The cabinet is a board and a score panel side by side; a narrow terminal
    // cannot hold both, so the score falls back to one line above the board.
    const wide = (ctx?.width ?? 62) >= BOARD_W + GAP + PANEL_W;
    if (wide) return [row([board, panel(state, t)], { gap: GAP })];
    return [
      text(`SCORE ${pad4(state.score)}   HI ${pad4(state.best)}   LEN ${state.snake.length}`, {
        color: t.accent,
      }),
      board,
      statusLine(state, t),
    ];
  },

  accent: (state) => (state.status === "over" ? theme().error : theme().accent),

  // A game in progress is worth a line on the cockpit; a finished one is not.
  dash: (state) =>
    state.status === "running" || state.status === "paused"
      ? {
          priority: state.status === "running" ? 20 : 10,
          text: `§ snake — ${state.score}`,
          note: state.status === "paused" ? "paused" : `len ${state.snake.length}`,
        }
      : null,

  // ←→↑↓ and wasd all fire `turn`; sharing a label collapses them into one
  // hint ("↑↓←→wasd turn") instead of eight.
  keymap: {
    up: { verb: "turn", args: { dir: "up" }, label: "turn" },
    down: { verb: "turn", args: { dir: "down" }, label: "turn" },
    left: { verb: "turn", args: { dir: "left" }, label: "turn" },
    right: { verb: "turn", args: { dir: "right" }, label: "turn" },
    w: { verb: "turn", args: { dir: "up" }, label: "turn" },
    a: { verb: "turn", args: { dir: "left" }, label: "turn" },
    s: { verb: "turn", args: { dir: "down" }, label: "turn" },
    d: { verb: "turn", args: { dir: "right" }, label: "turn" },
    space: { verb: "toggle", label: "start/pause" },
    n: { verb: "newGame", label: "new game" },
  },

  nav: { back: "back", backLabel: "pause", canBack: (s) => s.status === "running" },

  cli: {
    usage: "kona snake",
    open: (_args, state) => (state.status === "over" ? { verb: "newGame" } : null),
  },

  notifications: {
    "snake.highscore": { summary: "you beat your own high score", default: false },
  },

  configSample: `[applets.snake]
# Walls kill, the way they did in 1982. false wraps the board edge to edge.
walls = true
# Starting pace: "slow" | "classic" | "fast".
speed = "classic"`,
});
