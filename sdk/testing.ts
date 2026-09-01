import { createTestRenderer } from "@opentui/core/testing";
import { TextAttributes } from "@opentui/core";
import type { CapturedFrame } from "@opentui/core";
import { createStage } from "../host/stage.ts";
import { filterApplets } from "../core/catalog.ts";
import { loadApplets } from "../core/load.ts";
import type { AnyApplet, AppletDef, AppletState } from "./index.ts";

/**
 * The applet author's test kit — render an applet the way the real host does,
 * headlessly, and assert on the text that comes out.
 *
 * This is the other half of the plugin boundary. An applet's rendering
 * regressions used to be assertions appended to one central
 * `tests/snapshot.test.ts`, which meant every new applet edited a shared file
 * and two of them collided over nothing. Instead an applet ships its own
 * `snapshots.ts` next to its `index.ts`; the runner discovers it exactly the
 * way the loader discovers the applet. Nothing central to append to, nothing to
 * conflict over.
 *
 *   // applets/timer/snapshots.ts
 *   export default defineSnapshots([
 *     { name: "running countdown", state: { ... }, contains: ["running", "█"] },
 *   ]);
 *
 * For anything a declarative fixture can't say, write a plain `*.test.ts` in
 * the package and call `renderApplet()` yourself — bun picks it up from there.
 */

/** Default frame size, matching bin/snapshot.ts. */
const DEFAULT_SIZE = { width: 62, height: 30 };

/**
 * One rendering regression: a state, a viewport, and what must (and must not)
 * be on screen. Every field but `name` is optional — the bare fixture renders
 * the applet's initial state, which is a real test on its own (empty states are
 * where applets crash).
 */
export interface AppletSnapshot {
  /** What this fixture pins, phrased as the behaviour: "running timer shows …". */
  name: string;
  /**
   * State to render, merged over the applet's `initialState` — a fixture names
   * only the fields it cares about. A function is called per run, for a state
   * that has to be built at test time (`Date.now()`).
   */
  state?: AppletState | (() => AppletState);
  width?: number;
  height?: number;
  /** Pin the timezone for the render (dates on screen). */
  tz?: string;
  /** Substrings that must appear in the frame. */
  contains?: string[];
  /** Substrings that must NOT appear. */
  excludes?: string[];
  /** Like `contains`, but matched with runs of whitespace collapsed to one. */
  collapsed?: string[];
  /**
   * Mark this fixture as the applet's HERO — the one frame that is the
   * applet's portrait, rendered into the README gallery by `bun run shots`.
   * Exactly one per applet; the first fixture is the hero when none says so,
   * which is why most files never mention it. Being a fixture too, the hero
   * is asserted on like any other: the gallery can only show a frame the
   * suite already holds to its contents.
   */
  hero?: boolean;
}

/** Identity helper — gives a fixture file types without importing them. */
export function defineSnapshots(snaps: AppletSnapshot[]): AppletSnapshot[] {
  return snaps;
}

/**
 * The applet's portrait: the fixture flagged `hero: true`, else the first one.
 * "Show me what you look like" without live data, auth, or a TTY — the gallery
 * shoots it, and a human or an agent can render it on demand.
 */
export function heroSnapshot(snaps: AppletSnapshot[]): AppletSnapshot | undefined {
  return snaps.find((s) => s.hero) ?? snaps[0];
}

/**
 * Render an applet to plain text through the real stage, with no TTY. Pass the
 * applet itself (a plugin has it in hand) or its id (loaded from disk).
 */
export async function renderApplet(
  target: AnyApplet | AppletDef<never> | string,
  state?: Record<string, unknown>,
  width = DEFAULT_SIZE.width,
  height = DEFAULT_SIZE.height,
): Promise<string> {
  const def =
    typeof target === "string" ? await byId(target) : (target as unknown as AnyApplet);
  return frame(width, height, (stage) => {
    stage.renderApplet(def, { ...def.initialState, ...(state ?? {}) } as AppletState);
  });
}

/**
 * Render the launcher — the one screen that belongs to no applet. `query` runs
 * the same filter the host runs, so a fixture can pin what typing narrows the
 * list to, and `cursor` indexes what is left after it.
 */
export async function renderLauncher(
  applets?: AnyApplet[],
  cursor = 0,
  width = DEFAULT_SIZE.width,
  height = DEFAULT_SIZE.height,
  query = "",
): Promise<string> {
  const all = applets ?? ((await loadApplets()) as unknown as AnyApplet[]);
  const list = filterApplets(all, query);
  return frame(width, height, (stage) =>
    stage.renderLauncher(list, cursor, { query, total: all.length }),
  );
}

/** Run one fixture; resolves with the failures, empty when it passes. */
export async function checkSnapshot(
  def: AnyApplet,
  snap: AppletSnapshot,
): Promise<string[]> {
  const state = typeof snap.state === "function" ? snap.state() : snap.state;
  const tz = process.env.TZ;
  if (snap.tz) process.env.TZ = snap.tz;
  let out: string;
  try {
    out = await renderApplet(def, state, snap.width, snap.height);
  } finally {
    if (snap.tz) {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  }
  return failures(out, snap);
}

/** What a rendered frame fails to say. Pure, so it is testable on its own. */
export function failures(frame: string, snap: AppletSnapshot): string[] {
  const flat = frame.replace(/\s+/g, " ");
  const out: string[] = [];
  for (const want of snap.contains ?? []) {
    if (!frame.includes(want)) out.push(`missing ${JSON.stringify(want)}`);
  }
  for (const want of snap.collapsed ?? []) {
    if (!flat.includes(want)) out.push(`missing ${JSON.stringify(want)} (whitespace-collapsed)`);
  }
  for (const nope of snap.excludes ?? []) {
    if (frame.includes(nope)) out.push(`should not contain ${JSON.stringify(nope)}`);
  }
  return out;
}

/**
 * Register one bun test per fixture. The repo's runner
 * (tests/snapshot.test.ts) calls this for every applet it discovers; a plugin
 * living outside the repo calls it from a one-line `snapshots.test.ts` of its
 * own, since nothing in this checkout scans its directory.
 */
export async function testSnapshots(def: AnyApplet, snaps: AppletSnapshot[]): Promise<void> {
  const { describe, test, expect } = await import("bun:test");
  describe(`${def.id} snapshots`, () => {
    for (const snap of snaps) {
      test(snap.name, async () => {
        expect(await checkSnapshot(def, snap)).toEqual([]);
      });
    }
  });
}

async function byId(id: string): Promise<AnyApplet> {
  const def = (await loadApplets()).find((a) => a.id === id);
  if (!def) throw new Error(`no such applet: ${id}`);
  return def as unknown as AnyApplet;
}

/** One headless frame. Each render gets its own renderer, torn down after. */
async function frame(
  width: number,
  height: number,
  draw: (stage: ReturnType<typeof createStage>) => void,
): Promise<string> {
  return shoot(width, height, draw, (cap) => cap.captureCharFrame());
}

/**
 * The same frame, with the colors kept. `captureCharFrame` flattens the cell
 * buffer to text (all a fixture needs); this hands back the styled runs the
 * stage actually painted, which is what `bun run shots` draws into an SVG.
 * The OpenTUI types stop here: callers get plain hexes and booleans.
 */
export async function renderAppletStyled(
  target: AnyApplet | AppletDef<never> | string,
  state?: Record<string, unknown>,
  width = DEFAULT_SIZE.width,
  height = DEFAULT_SIZE.height,
): Promise<StyledFrame> {
  const def =
    typeof target === "string" ? await byId(target) : (target as unknown as AnyApplet);
  return shoot(
    width,
    height,
    (stage) => stage.renderApplet(def, { ...def.initialState, ...(state ?? {}) } as AppletState),
    (cap) => styled(cap.captureSpans(), width, height),
  );
}

/** A run of cells the stage painted with one style. */
export interface StyledSpan {
  text: string;
  /** `#rrggbb`. */
  fg: string;
  /** `#rrggbb`, or null when the cell keeps the terminal's background. */
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** Columns the run occupies — wide glyphs count double. */
  width: number;
}

/** A whole frame of them: `rows` lines of `cols` columns. */
export interface StyledFrame {
  cols: number;
  rows: number;
  lines: StyledSpan[][];
}

/** OpenTUI's capture -> our own plain shape. */
function styled(cap: CapturedFrame, cols: number, rows: number): StyledFrame {
  const attr = (a: number, bit: number) => (a & bit) !== 0;
  return {
    cols: cap.cols || cols,
    rows: cap.rows || rows,
    lines: cap.lines.map((line) =>
      line.spans.map((s) => ({
        text: s.text,
        fg: hex(s.fg),
        // A zero-alpha background is "whatever the terminal has" — the shot
        // paints those cells with the theme's own backdrop instead.
        bg: s.bg && s.bg.toInts()[3] > 0 ? hex(s.bg) : null,
        bold: attr(s.attributes, TextAttributes.BOLD),
        dim: attr(s.attributes, TextAttributes.DIM),
        italic: attr(s.attributes, TextAttributes.ITALIC),
        underline: attr(s.attributes, TextAttributes.UNDERLINE),
        width: s.width,
      })),
    ),
  };
}

function hex(c: { toInts(): [number, number, number, number] }): string {
  const [r, g, b] = c.toInts();
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Drive the stage once through a headless renderer and capture the result. */
async function shoot<T>(
  width: number,
  height: number,
  draw: (stage: ReturnType<typeof createStage>) => void,
  capture: (cap: Awaited<ReturnType<typeof createTestRenderer>>) => T,
): Promise<T> {
  const cap = await createTestRenderer({ width, height });
  const stage = createStage(cap.renderer);
  draw(stage);
  await cap.renderOnce();
  const out = capture(cap);
  // Each call spins up a renderer; tear it down so a test file full of
  // snapshots doesn't pile up listeners on the shared console cache.
  cap.renderer.destroy();
  return out;
}
