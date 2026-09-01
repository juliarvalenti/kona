import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
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
}

/** Identity helper — gives a fixture file types without importing them. */
export function defineSnapshots(snaps: AppletSnapshot[]): AppletSnapshot[] {
  return snaps;
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

/** Render the launcher — the one screen that belongs to no applet. */
export async function renderLauncher(
  applets?: AnyApplet[],
  cursor = 0,
  width = DEFAULT_SIZE.width,
  height = DEFAULT_SIZE.height,
): Promise<string> {
  const list = applets ?? ((await loadApplets()) as unknown as AnyApplet[]);
  return frame(width, height, (stage) => stage.renderLauncher(list, cursor));
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
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
  const stage = createStage(renderer);
  draw(stage);
  await renderOnce();
  const out = captureCharFrame();
  // Each call spins up a renderer; tear it down so a test file full of
  // snapshots doesn't pile up listeners on the shared console cache.
  renderer.destroy();
  return out;
}
