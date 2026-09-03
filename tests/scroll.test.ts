import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage, type Stage } from "../host/stage.ts";
import { clampScroll, scrollToShow } from "../host/scroll.ts";
import { box, col, defineApplet, text, type AppletDef, type LayoutOpts, type ViewNode } from "../sdk/index.ts";

/**
 * Scrolling, measured against the frame that actually gets drawn.
 *
 * Every scroll bug we shipped had the same shape: the follow math and the
 * renderer disagreed about the SIZE OF THINGS. The math counted a row as one
 * line; the renderer wrapped it to three. The math counted a box's borders;
 * the renderer drew none. The math sized the viewport from the terminal; the
 * renderer sized it from the layout. None of that is visible to a test that
 * asks the math to check its own arithmetic, which is why the focus tests
 * stayed green through every one of those regressions.
 *
 * So nothing here trusts a number the host computed. Every test renders a real
 * frame through the real stage, reads the CHARACTERS back, and asks where the
 * selected row landed on screen. The two rules, in the terms a human would put
 * them:
 *
 *   1. the selected row is always on screen, and
 *   2. the view moves ONLY when it has to — a row with space below it does not
 *      drag the whole list down with it.
 *
 * The host now keeps them by MEASURING (host/stage.ts asks the layout where
 * the row it just built ended up), so the way to break these tests again is to
 * reintroduce a prediction. If you are adding one, add it here first.
 */

// --- The harness -----------------------------------------------------------

/** Terminal the walks run in: short enough that a 40-row list must scroll. */
const SIZE = { width: 44, height: 20 };

/** How many list rows the applets below draw. */
const ROWS = 40;

/** A row's unique label, so it can be found in the captured characters. */
const label = (i: number) => `item-${String(i).padStart(2, "0")}`;

/**
 * A cursored list, the shape every list applet in kona has: rows in a `col`,
 * the one under the cursor carrying `focus` (which is what the stage follows).
 * `header` is whatever sits above the list, and is where the interesting cases
 * live — it is the lines ABOVE the selection that decide where it really is.
 */
function listApplet(header: ViewNode[] = [], opts: LayoutOpts = {}): AppletDef {
  return defineApplet({
    id: "probe",
    title: "probe",
    summary: "a cursored list",
    initialState: { cursor: 0 },
    verbs: {},
    view: (s: { cursor: number }) => [
      ...header,
      col(
        Array.from({ length: ROWS }, (_, i) =>
          text(`${i === s.cursor ? "▸" : " "} ${label(i)}`, { focus: i === s.cursor }),
        ),
        opts,
      ),
    ],
  }) as unknown as AppletDef;
}

interface Frame {
  /** The stage's scroll offset after the frame was drawn. */
  scrollTop: number;
  /** Screen row of the selected row, or -1 when it is not on screen at all. */
  selectedRow: number;
  /** Screen row of the LAST list row the frame drew — the bottom of the fold. */
  lastRow: number;
  /** Row labels the frame actually shows, in order. */
  shown: string[];
  /** The raw characters, for the odd direct assertion. */
  text: string;
}

/**
 * One live stage across many frames — the host renders into the SAME stage on
 * every keystroke, and the scroll offset it carries between frames is half of
 * what these tests are about. Re-creating the stage per frame (as
 * tests/launcher.test.ts does) hides every bug that needs two frames to show.
 */
async function session(def: AppletDef, size = SIZE) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(size);
  const stage = createStage(renderer);

  const read = (cursor: number): Frame => {
    const frame = captureCharFrame();
    const lines = frame.split("\n");
    const rowOf = (s: string) => lines.findIndex((l) => l.includes(s));
    return {
      scrollTop: stage.scrollTop(),
      selectedRow: rowOf(`▸ ${label(cursor)}`),
      lastRow: lines.reduce((acc, l, i) => (/item-\d\d/.test(l) ? i : acc), -1),
      shown: lines.map((l) => (l.match(/item-\d\d/) ?? [])[0]).filter(Boolean) as string[],
      text: frame,
    };
  };

  /** Draw the applet with the cursor on `i` — one press of ↓ or ↑. */
  const press = async (cursor: number): Promise<Frame> => {
    stage.renderApplet(def, { cursor } as never);
    await renderOnce();
    return read(cursor);
  };

  // Draw once before anything is asserted: the first frame of a fresh stage is
  // laid out against a viewport that does not exist yet, and the host's own
  // first frame is followed by a state push within milliseconds.
  await press(0);

  return {
    stage: stage as Stage,
    press,
    /** ↓ from 0 to `to`, collecting a frame per press. */
    walkDown: async (to: number) => {
      const frames: Frame[] = [];
      for (let c = 0; c <= to; c++) frames.push(await press(c));
      return frames;
    },
    done: () => renderer.destroy(),
  };
}

// --- The arithmetic, on its own --------------------------------------------

test("clampScroll never leaves the content", () => {
  expect(clampScroll(-5, 100, 10)).toBe(0);
  expect(clampScroll(500, 100, 10)).toBe(90);
  expect(clampScroll(42, 100, 10)).toBe(42);
  expect(clampScroll(5, 8, 10)).toBe(0); // a list that fits has nowhere to go
});

test("scrollToShow moves only for a row that is off screen", () => {
  expect(scrollToShow(0, 5, 10)).toBe(0); // already visible: stay put
  expect(scrollToShow(0, 9, 10)).toBe(0); // the last visible line is still visible
  expect(scrollToShow(0, 10, 10)).toBe(1); // one past the fold: one line of scroll
  expect(scrollToShow(6, 2, 10)).toBe(2); // above the fold: pull back to it
  expect(scrollToShow(6, null, 10)).toBe(6); // no selection: leave the view alone
});

test("the stage follows the selection with the arithmetic in host/scroll.ts", () => {
  // The rule above has to be the one that RUNS. The stage used to keep an
  // inline copy of it (with a `peek` term this one had never heard of), so the
  // tests above passed while the screen misbehaved and every fix to scroll.ts
  // changed nothing at all. One copy, called from one place.
  const src = readFileSync(join(import.meta.dir, "..", "host", "stage.ts"), "utf8");
  expect(src.includes("scrollToShow(")).toBe(true);
});

// --- The viewport the follow math thinks it has ----------------------------

test("the viewport the follow math measures is the viewport the frame draws", async () => {
  const s = await session(listApplet());
  const frame = await s.press(0);
  // "Off screen" is only meaningful against the height the body actually got.
  // The estimate the stage makes from the terminal size (`innerHeight()`, for
  // sizing a view before there is a frame) comes out a line shorter than
  // flexbox's answer — follow against that and every list scrolls a row early.
  expect(s.stage.viewportHeight()).toBe(frame.shown.length);
  s.done();
});

test("the first frame draws as many rows as the second", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  const def = listApplet();
  const rows = () => captureCharFrame().split("\n").filter((l) => /item-\d\d/.test(l)).length;

  stage.renderApplet(def, { cursor: 0 } as never);
  await renderOnce();
  const first = rows();
  stage.renderApplet(def, { cursor: 0 } as never);
  await renderOnce();
  const second = rows();
  renderer.destroy();

  // The ScrollBox reserves a row for a horizontal scrollbar until it works out
  // that it has nothing to scroll sideways, so the first frame of every screen
  // used to be a line shorter than the rest — and was followed as such.
  expect(first).toBe(second);
});

// --- Rule 2: the view moves only when it has to ----------------------------

test("↓ does not scroll while there is still a row below the selection", async () => {
  const s = await session(listApplet());
  const frames = await s.walkDown(20);
  s.done();

  // The frame BEFORE the first scroll must have the cursor on the last drawn
  // row: if it still had a row under it, the list moved for nothing.
  const firstScroll = frames.findIndex((f) => f.scrollTop > 0);
  expect(firstScroll).toBeGreaterThan(0);
  const before = frames[firstScroll - 1]!;
  expect(before.lastRow - before.selectedRow).toBe(0);
});

test("an unbordered box above the list does not drag the view with the cursor", async () => {
  // The reported bug, in the smallest shape that showed it: a plain `box` — no
  // border asked for, and none drawn — above a list. The follow used to count
  // two border lines the frame never drew, believed the selection was two
  // lines lower than it was, and from there dragged the whole list on every ↓
  // while the cursor sat parked THREE rows above the bottom of the frame.
  const s = await session(listApplet([box([text("alpha"), text("beta")])]));
  const frames = await s.walkDown(14);
  s.done();

  for (const [i, f] of frames.entries()) {
    if (f.scrollTop === 0) continue;
    const roomBelow = f.lastRow - f.selectedRow;
    expect({ cursor: i, roomBelow, scrollTop: f.scrollTop }).toEqual({
      cursor: i,
      roomBelow: 0,
      scrollTop: f.scrollTop,
    });
  }
});

test("↓ never scrolls a list that fits on screen", async () => {
  const s = await session(listApplet(), { width: 44, height: 60 });
  const frames = await s.walkDown(ROWS - 1);
  s.done();
  expect(frames.map((f) => f.scrollTop)).toEqual(frames.map(() => 0));
});

// --- Rule 1: the selection is always on screen -----------------------------

test("walking the whole list keeps the selection on screen", async () => {
  const s = await session(listApplet());
  const frames = await s.walkDown(ROWS - 1);
  s.done();
  const lost = frames.flatMap((f, i) => (f.selectedRow < 0 ? [i] : []));
  expect(lost).toEqual([]);
});


test("walking back up returns the view to the top", async () => {
  const s = await session(listApplet());
  await s.walkDown(ROWS - 1);
  for (let c = ROWS - 1; c >= 0; c--) await s.press(c);
  const top = await s.press(0);
  s.done();
  expect(top.scrollTop).toBe(0);
  expect(top.shown[0]).toBe(label(0));
});

// --- Every shape of list, walked ------------------------------------------
//
// One table, one walk each: the header above a list is what decides where its
// rows really are, and each of these used to break the follow in its own way.

const SHAPES: { name: string; header?: ViewNode[]; opts?: LayoutOpts }[] = [
  { name: "a plain list", },
  { name: "a list under a titled box", header: [box([text("a"), text("b")], { title: "hi" })] },
  { name: "a list under an unbordered box", header: [box([text("a"), text("b")])] },
  { name: "a list under a padded box", header: [box([text("a")], { border: true, padding: 1 })] },
  { name: "a list with a gap between its rows", opts: { gap: 1 } },
  { name: "a list under a line that wraps", header: [text("wrap ".repeat(40))] },
];

for (const shape of SHAPES) {
  test(`${shape.name}: ↓ keeps the selection on screen, and moves the view only when it must`, async () => {
    const s = await session(listApplet(shape.header ?? [], shape.opts ?? {}));
    const frames = await s.walkDown(24);
    s.done();

    // Rule 1: the cursor is never off screen.
    expect(frames.flatMap((f, i) => (f.selectedRow < 0 ? [i] : []))).toEqual([]);
    // Rule 2: nothing scrolls while the selection still has a row under it.
    for (const [i, f] of frames.entries()) {
      if (f.scrollTop === 0) continue;
      expect({ cursor: i, roomBelow: f.lastRow - f.selectedRow }).toEqual({ cursor: i, roomBelow: 0 });
    }
    // And the view only ever moved down, a line at a time — no jumps.
    const steps = frames.slice(1).map((f, i) => f.scrollTop - frames[i]!.scrollTop);
    expect(steps.every((d) => d >= 0)).toBe(true);
  });
}

test("a body that changes height under the cursor still follows it", async () => {
  // The theme picker's shape, boiled down: the header re-letters as you move,
  // so the list is a different height on every frame. That is the case where
  // the ScrollBox recalculates mid-flight — new viewport height, old content
  // height — and re-clamps the scroll offset to a maximum that has just
  // stopped being true, dropping the selected row one line under the fold.
  const def = defineApplet({
    id: "probe",
    title: "probe",
    summary: "a list under a header that breathes",
    initialState: { cursor: 0 },
    verbs: {},
    view: (s: { cursor: number }) => [
      // 1 to 6 lines of header, cycling — the hero of a picker, in miniature.
      col(Array.from({ length: 1 + (s.cursor % 6) }, (_, i) => text(`header ${i}`))),
      col(
        Array.from({ length: ROWS }, (_, i) =>
          text(`${i === s.cursor ? "▸" : " "} ${label(i)}`, { focus: i === s.cursor }),
        ),
      ),
    ],
  }) as unknown as AppletDef;

  const s = await session(def);
  const frames = await s.walkDown(ROWS - 1);
  s.done();
  expect(frames.flatMap((f, i) => (f.selectedRow < 0 ? [i] : []))).toEqual([]);
});

// --- The launcher, which is the same rules on a two-line row ---------------

/** `n` applets, the shape tests/launcher.test.ts uses. */
function many(n: number): AppletDef[] {
  return Array.from({ length: n }, (_, i) =>
    defineApplet({
      id: `app-${String(i).padStart(2, "0")}`,
      title: `App ${String(i).padStart(2, "0")}`,
      summary: `what app ${String(i).padStart(2, "0")} is for`,
      icon: "◆",
      initialState: {},
      verbs: {},
      view: () => [],
    }) as unknown as AppletDef,
  );
}

test("↓ through the launcher does not scroll while entries are still below", async () => {
  const applets = many(30);
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  const frames: { scrollTop: number; selectedRow: number; lastRow: number }[] = [];
  stage.renderLauncher(applets, 0); // settle
  await renderOnce();
  for (let c = 0; c < 12; c++) {
    stage.renderLauncher(applets, c);
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    frames.push({
      scrollTop: stage.scrollTop(),
      selectedRow: lines.findIndex((l) => l.includes(`▸`) && l.includes(`App ${String(c).padStart(2, "0")}`)),
      lastRow: lines.reduce((acc, l, i) => (/App \d\d/.test(l) ? i : acc), -1),
    });
  }
  renderer.destroy();

  // A launcher entry is two lines (title + summary), and `peek` keeps the
  // summary on screen with its title — so at the fold the selected title is the
  // LAST title drawn, with only its own summary under it. A further title still
  // on screen means the view was dragged by a cursor that had room to move.
  for (const [i, f] of frames.entries()) {
    if (f.scrollTop === 0) continue;
    expect({ cursor: i, titlesBelow: f.lastRow - f.selectedRow }).toEqual({ cursor: i, titlesBelow: 0 });
  }
});

test("the launcher keeps the selected entry's summary line with it", async () => {
  const applets = many(30);
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  const missing: number[] = [];
  stage.renderLauncher(applets, 0);
  await renderOnce();
  for (let c = 0; c < 30; c++) {
    stage.renderLauncher(applets, c);
    await renderOnce();
    const frame = captureCharFrame();
    const num = String(c).padStart(2, "0");
    if (!frame.includes(`App ${num}`) || !frame.includes(`what app ${num} is for`)) missing.push(c);
  }
  renderer.destroy();
  expect(missing).toEqual([]);
});

// --- Scrolling by hand, and what the next frame does to it -----------------

test("the wheel can reach the last row of a list", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  stage.renderApplet(listApplet(), { cursor: 0 } as never);
  await renderOnce();
  stage.scrollBy(1000);
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  expect(frame).toContain(label(ROWS - 1));
});

test("the wheel and the follow math agree on how tall the viewport is", async () => {
  // Two paths, one answer. The wheel (`scrollBy`) and the follow (↑↓) both
  // clamp against the height of the body, so the bottom of a list is the same
  // place however you got there. They used to differ by a line, which is the
  // last row of every list being unreachable one way and not the other.
  const { renderer, renderOnce } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  stage.renderApplet(listApplet(), { cursor: 0 } as never);
  await renderOnce();
  stage.scrollBy(1000); // wheel all the way down
  await renderOnce();
  const bottom = stage.scrollTop();
  const vh = stage.viewportHeight();
  renderer.destroy();
  expect(ROWS - vh).toBe(bottom);
});

test("a wheel scroll survives a repaint that did not move the cursor", async () => {
  // The other half of the report: scroll-into-view eating a scroll you made
  // yourself. Wheel down a cursored list to read ahead and the next repaint —
  // an SSE state push, a scrubber tick, a poll — used to yank the view back to
  // the cursor, which in a live applet meant you could not read ahead at all.
  // A hand scroll now holds until the SELECTION moves.
  const { renderer, renderOnce } = await createTestRenderer(SIZE);
  const stage = createStage(renderer);
  const def = listApplet();
  stage.renderApplet(def, { cursor: 0 } as never);
  await renderOnce();

  stage.scrollBy(8);
  await renderOnce();
  const scrolled = stage.scrollTop();
  expect(scrolled).toBe(8);

  stage.renderApplet(def, { cursor: 0 } as never); // idle refresh, same state
  await renderOnce();
  const after = stage.scrollTop();
  renderer.destroy();
  expect(after).toBe(scrolled);
});
