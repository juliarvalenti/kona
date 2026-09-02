import {
  appletNumber,
  big,
  box,
  col,
  fitBigFont,
  row,
  text,
  theme,
  defineApplet,
  type AppletCtx,
  type Color,
  type Theme,
  type ViewNode,
} from "../../sdk/index.ts";

/**
 * 2048 — the bimodal one.
 *
 * Snake is a game with a clock; this is a game with a TURN. The world moves
 * only when a move is made, which is what makes it genuinely playable over
 * HTTP: `kona call 2048 left` is the same move, on the same board, that the
 * arrow key makes — nothing has gone stale between reading the grid and
 * answering it. You can watch an agent play it, and (`auto`) you can watch the
 * applet play itself.
 *
 * There is no `tick` here on purpose.
 */

/** Board edge. Four, like everyone else's 2048. */
const N = 4;
/** A tile is this wide and this tall, in cells. */
const TILE_W = 7;
const TILE_H = 3;
const BOARD_W = N * TILE_W + (N - 1) + 2; // tiles, gutters, border
const GAP = 2;
const PANEL_W = 38;

type Status = "playing" | "won" | "over";

interface Game2048State {
  /** Row-major, `N * N` long. 0 is an empty cell. */
  grid: number[];
  score: number;
  /** The high score. Applet state is persisted, so it outlives the daemon. */
  best: number;
  /** The biggest tile ever reached here — a second kind of high score. */
  bestTile: number;
  moves: number;
  status: Status;
  /**
   * Where the newest tile landed. Nothing on screen depends on it — it is here
   * for the caller reading the board back, who otherwise has to diff two grids
   * to find the one tile it did not put there.
   */
  spawned: number;
  /** The LCG behind spawns. Same seed, same game. */
  seed: number;
}

type Dir = "left" | "right" | "up" | "down";
/** Every direction, in the order `auto` breaks a tie — see `bestMove`. */
const DIRS: Dir[] = ["left", "down", "right", "up"];
const isDir = (v: unknown): v is Dir => typeof v === "string" && (DIRS as string[]).includes(v);

/** The tile you are playing towards. `goal` in the config moves the finish line. */
const goal = () => appletNumber("2048", "goal", 2048);

/** One draw from the game's own generator, so a seed replays a whole game. */
function rand(state: Game2048State): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

/** Drop a 2 (nine times in ten) or a 4 onto a free cell. */
function spawn(state: Game2048State): void {
  const free: number[] = [];
  for (let i = 0; i < state.grid.length; i++) if (state.grid[i] === 0) free.push(i);
  const at = free[Math.floor(rand(state) * free.length)];
  if (at === undefined) return;
  state.grid[at] = rand(state) < 0.9 ? 2 : 4;
  state.spawned = at;
}

/** The indices of one line, in the order tiles travel when moving `dir`. */
function lane(dir: Dir, i: number): number[] {
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    if (dir === "left") idx.push(i * N + j);
    else if (dir === "right") idx.push(i * N + (N - 1 - j));
    else if (dir === "up") idx.push(j * N + i);
    else idx.push((N - 1 - j) * N + i);
  }
  return idx;
}

/**
 * Slide one line towards its head and merge each pair once. Returns the new
 * line and what it scored — the whole rule set of the game, in nine lines.
 */
function squash(line: number[]): { line: number[]; gained: number } {
  const tiles = line.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    // A tile merges at most once per move, so the pair it made is skipped.
    if (tiles[i] === tiles[i + 1]) {
      const merged = tiles[i]! * 2;
      out.push(merged);
      gained += merged;
      i++;
    } else out.push(tiles[i]!);
  }
  while (out.length < N) out.push(0);
  return { line: out, gained };
}

/** The grid one move would leave behind, and what it would score. */
function slide(grid: number[], dir: Dir): { grid: number[]; gained: number; moved: boolean } {
  const next = grid.slice();
  let gained = 0;
  let moved = false;
  for (let i = 0; i < N; i++) {
    const idx = lane(dir, i);
    const before = idx.map((k) => grid[k]!);
    const after = squash(before);
    gained += after.gained;
    idx.forEach((k, j) => {
      if (next[k] !== after.line[j]!) moved = true;
      next[k] = after.line[j]!;
    });
  }
  return { grid: next, gained, moved };
}

/** Is there anything left to do — an empty cell, or two neighbours that match? */
function hasMoves(grid: number[]): boolean {
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const v = grid[i * N + j]!;
      if (v === 0) return true;
      if (j + 1 < N && grid[i * N + j + 1] === v) return true;
      if (i + 1 < N && grid[(i + 1) * N + j] === v) return true;
    }
  }
  return false;
}

/**
 * Make a move. A move that changes nothing is not a move: no tile spawns, the
 * count doesn't rise, and `moved: false` comes back — which is exactly what an
 * agent needs to know before it tries the same direction again.
 */
function move(state: Game2048State, dir: Dir): { moved: boolean; gained: number; status: Status } {
  if (state.status === "over") return { moved: false, gained: 0, status: state.status };
  const { grid, gained, moved } = slide(state.grid, dir);
  if (!moved) return { moved: false, gained: 0, status: state.status };
  state.grid = grid;
  state.score += gained;
  state.moves += 1;
  spawn(state);
  const top = Math.max(...state.grid);
  if (top > state.bestTile) state.bestTile = top;
  // Reaching the goal is a milestone, not an ending — the board plays on.
  if (state.status === "playing" && top >= goal()) state.status = "won";
  if (!hasMoves(state.grid)) state.status = "over";
  if (state.score > state.best) state.best = state.score;
  return { moved: true, gained, status: state.status };
}

/** A fresh board: two tiles and nothing else. The high scores stay. */
function deal(state: Game2048State, seed?: number): void {
  state.grid = new Array(N * N).fill(0);
  state.score = 0;
  state.moves = 0;
  state.status = "playing";
  state.spawned = -1;
  if (seed !== undefined) state.seed = seed >>> 0;
  spawn(state);
  spawn(state);
}

/**
 * The applet playing itself: one greedy move, chosen by what it merges and how
 * much room it leaves. Deliberately simple — it is a demo of the seam, not a
 * solver — and deterministic, so `auto` on a seeded board plays out the same
 * way twice. Ties break on DIRS order, which keeps the big tiles drifting into
 * one corner instead of wandering.
 */
function bestMove(state: Game2048State): Dir | null {
  let best: { dir: Dir; value: number } | null = null;
  for (const dir of DIRS) {
    const { grid, gained, moved } = slide(state.grid, dir);
    if (!moved) continue;
    const empties = grid.filter((v) => v === 0).length;
    const value = gained * 2 + empties;
    if (!best || value > best.value) best = { dir, value };
  }
  return best?.dir ?? null;
}

// --- rendering: the board is a col of rows of colored text cells.

/**
 * Tile colors: a heat ramp made of theme ROLES, not hexes, so the board reskins
 * with the palette. It CLIMBS AND STOPS rather than repeating — a handful of
 * roles cannot keep up with a number that keeps doubling, and wrapping would
 * draw the biggest tile in the coolest color, which reads as the smallest.
 */
function ramp(t: Theme): Color[] {
  // `dim` is left out on purpose: it and `muted` are a shade apart in most
  // palettes, and two rungs you cannot tell apart are worse than one rung less.
  return [t.field, t.muted, t.accent, t.alt, t.ok, t.warn, t.error];
}

const tileColor = (value: number, t: Theme): Color => {
  const r = ramp(t);
  // log2(2) = 1 is the first rung; everything from 128 up shares the last.
  return r[Math.min(Math.round(Math.log2(value)) - 1, r.length - 1)]!;
};

/** Center a label in a tile, the way a tile in this game always reads. */
function center(label: string, width = TILE_W): string {
  const pad = Math.max(0, width - label.length);
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + label + " ".repeat(pad - left);
}

/** One row of tiles: TILE_H lines of colored, filled cells. */
function tileRows(state: Game2048State, r: number, t: Theme): ViewNode[] {
  const lines: ViewNode[] = [];
  for (let line = 0; line < TILE_H; line++) {
    const cells: ViewNode[] = [];
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      const v = state.grid[i]!;
      const bg = v === 0 ? t.panel : tileColor(v, t);
      // The value sits on the middle line; the other two are the tile's body.
      const label = line === 1 && v !== 0 ? center(String(v)) : " ".repeat(TILE_W);
      cells.push(text(label, { bg, color: t.bg }));
    }
    lines.push(row(cells, { gap: 1 }));
  }
  return lines;
}

/** The board, plus a banner when the game has something to say. */
function board(state: Game2048State, t: Theme): ViewNode {
  const rows: ViewNode[] = [];
  for (let r = 0; r < N; r++) rows.push(...tileRows(state, r, t));
  if (state.status === "over") {
    rows[Math.floor((N * TILE_H) / 2)] = text(center("GAME OVER", N * TILE_W + N - 1), { color: t.error });
  }
  return box(rows, {
    border: true,
    borderColor: state.status === "over" ? t.error : t.accent,
    width: BOARD_W,
  });
}

/** What the board is saying right now, in one line. */
function statusLine(state: Game2048State, t: Theme): ViewNode {
  if (state.status === "over") return text("NO MOVES LEFT — N TO DEAL AGAIN", { color: t.error });
  if (state.status === "won") return text(`${goal()}! AND STILL PLAYING`, { color: t.ok });
  return text("YOUR MOVE", { dim: true });
}

/** The score panel: the `big` hero, and the numbers that outlive the board. */
function panel(state: Game2048State, t: Theme): ViewNode {
  const score = String(state.score);
  return col(
    [
      // `big` sizes itself against the whole pane, not this column, so the
      // figlet is narrowed here to the one that fits beside the board. It
      // starts from the theme's, so a theme still re-letters it.
      big(score, t.accent, fitBigFont(score, t.font, { width: PANEL_W, height: 6 })),
      text("SCORE", { dim: true }),
      text(""),
      text(`BEST     ${state.best}`, { color: t.alt }),
      text(`TILE     ${state.bestTile}`),
      text(`MOVES    ${state.moves}`),
      text(""),
      statusLine(state, t),
    ],
    { gap: 0 },
  );
}

/** A move and the repaint it earns — what all five move verbs come down to. */
function slid(ctx: AppletCtx<Game2048State>, dir: Dir) {
  const out = move(ctx.state, dir);
  ctx.emit();
  return out;
}

export default defineApplet<Game2048State>({
  id: "2048",
  title: "2048",
  summary: "Slide, merge, repeat. Turn-based, so an agent can play it too.",
  icon: "◫",
  tint: "#eab308",
  labels: ["game"],
  initialState: {
    grid: new Array(N * N).fill(0),
    score: 0,
    best: 0,
    bestTile: 0,
    moves: 0,
    status: "playing",
    spawned: -1,
    seed: 1,
  },

  /** An empty board on first boot is not a game — deal one. */
  init({ state, emit }) {
    if (state.grid.every((v) => v === 0)) {
      deal(state, state.seed);
      emit();
    }
  },

  verbs: {
    left: (_a, ctx) => slid(ctx, "left"),
    right: (_a, ctx) => slid(ctx, "right"),
    up: (_a, ctx) => slid(ctx, "up"),
    down: (_a, ctx) => slid(ctx, "down"),
    /** The four above, by name — for a caller holding a direction in a variable. */
    move: (args, ctx) => {
      if (!isDir(args.dir)) throw new Error("move: dir must be one of left/right/up/down");
      return slid(ctx, args.dir);
    },
    /** Deal a new board. `{ "seed": 7 }` deals the same one every time. */
    newGame: (args, { state, emit }) => {
      deal(state, typeof args.seed === "number" ? args.seed : undefined);
      emit();
      return { grid: state.grid, seed: state.seed };
    },
    /**
     * Let the applet play itself for a few moves — the "watch an agent play"
     * demo, with the agent inlined. Stops early when the board does.
     */
    auto: (args, { state, emit }) => {
      const want = typeof args.moves === "number" ? Math.floor(args.moves) : 1;
      const n = Math.max(1, Math.min(500, want));
      let played = 0;
      for (let i = 0; i < n; i++) {
        const dir = bestMove(state);
        if (!dir || !move(state, dir).moved) break;
        played++;
      }
      emit();
      return { played, score: state.score, tile: state.bestTile, status: state.status };
    },
  },

  // A move is a move: it touches nothing but this board, so an agent plays
  // without waiting on an approval.
  priority: { left: "low", right: "low", up: "low", down: "low", move: "low", newGame: "low", auto: "low" },

  docs: {
    left: "Slide left.",
    right: "Slide right.",
    up: "Slide up.",
    down: "Slide down.",
    move: { doc: "Slide, naming the direction.", args: { dir: "left" } },
    newGame: { doc: "Deal a new board, keeping the high score. Same seed, same game.", args: { seed: 7 } },
    auto: { doc: "Let the applet play itself, greedily, for a few moves.", args: { moves: 20 } },
  },

  recipes: [
    {
      title: "Play a game",
      steps: [
        "kona call 2048 newGame '{\"seed\":7}'",
        "kona state 2048",
        "kona call 2048 left",
        "kona call 2048 down",
      ],
      note: "Turn-based: the board only moves when you do, so the grid you read is the grid you are answering. A move that changes nothing comes back `moved: false` — try another direction rather than the same one.",
    },
    {
      title: "Watch it play itself",
      steps: ["kona call 2048 newGame '{\"seed\":7}'", "kona call 2048 auto '{\"moves\":40}'", "kona state 2048"],
      note: "`auto` is a greedy one-move-ahead player. Open the applet in the TUI first and the board slides under you as it goes.",
    },
  ],

  view(state, ctx) {
    const t = theme();
    const grid = board(state, t);
    // Board and score panel side by side; a narrow terminal keeps the board and
    // trades the hero for one line.
    if ((ctx?.width ?? 62) >= BOARD_W + GAP + PANEL_W) {
      return [row([grid, panel(state, t)], { gap: GAP })];
    }
    return [
      text(`SCORE ${state.score}   BEST ${state.best}   TILE ${state.bestTile}`, { color: t.accent }),
      grid,
      statusLine(state, t),
    ];
  },

  accent: (state) => (state.status === "over" ? theme().error : theme().accent),

  // A board mid-game is worth a quiet line; a finished one is not.
  dash: (state) =>
    state.moves > 0 && state.status !== "over"
      ? { priority: 10, text: `◫ 2048 — ${state.score}`, note: `tile ${Math.max(...state.grid)}` }
      : null,

  keymap: {
    up: { verb: "up", label: "slide" },
    down: { verb: "down", label: "slide" },
    left: { verb: "left", label: "slide" },
    right: { verb: "right", label: "slide" },
    w: { verb: "up", label: "slide" },
    a: { verb: "left", label: "slide" },
    s: { verb: "down", label: "slide" },
    d: { verb: "right", label: "slide" },
    n: { verb: "newGame", label: "new game" },
    ".": { verb: "auto", args: { moves: 1 }, label: "auto move" },
  },

  cli: {
    usage: "kona 2048",
    open: (args) => (args[0] === "new" ? { verb: "newGame" } : null),
  },

  // The id is all digits, so TOML wants it quoted — `[applets.2048]` is a
  // parse error where `[applets."2048"]` is the table this reads.
  configSample: `[applets."2048"]
# The tile that wins it. The board plays on afterwards either way.
goal = 2048`,
});
