import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage, type Stage } from "../host/stage.ts";
import { focusLineOf } from "../host/nodes.ts";
import { clampScroll, scrollToShow } from "../host/scroll.ts";
import { box, col, defineApplet, text, type AppletDef, type LayoutOpts, type ViewNode } from "../sdk/index.ts";

/**
 * Scrolling, measured against the frame that actually gets drawn.
 *
 * Every scroll bug we have shipped has the same shape: the follow math and the
 * renderer disagree about the SIZE OF THINGS. The math counts a row as one
 * line; the renderer wraps it to three. The math counts a box's borders; the
 * renderer draws none. The math sizes the viewport from the terminal; the
 * renderer sizes it from the layout. Each disagreement is invisible in a test
 * that asks the math to check its own arithmetic — which is what
 * `tests/nodes.test.ts` does, and why it has been green through every one of
 * these regressions.
 *
 * So nothing here trusts a number the host computed. Every test renders a real
 * frame through the real stage, reads the CHARACTERS back, and asks where the
 * selected row landed on screen. The rules being checked are the two the host
 * claims:
 *
 *   1. the selected row is always on screen, and
 *   2. the view moves ONLY when it has to — a row with space below it does not
 *      drag the whole list down with it.
 *
 * Tests marked `test.failing` are live reproductions: they describe the rule,
 * they fail against today's host, and bun reports them as failures the day the
 * bug is fixed — at which point drop the `.failing`.
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

/**
 * The line a focused row is REALLY drawn on, counted from the top of the
 * content — the number `focusLineOf` is trying to predict.
 *
 * Measured, not derived: rendered in a viewport tall enough that nothing
 * scrolls, with a sentinel as the first node so the origin needs no assumption
 * about how many lines of chrome sit above the content.
 */
async function measuredLine(header: ViewNode[], opts: LayoutOpts = {}, cursor = 0) {
  const ORIGIN = "◇origin◇";
  const def = listApplet([text(ORIGIN), ...header], opts);
  const s = await session(def, { width: SIZE.width, height: 60 });
  const frame = await s.press(cursor);
  const lines = frame.text.split("\n");
  const origin = lines.findIndex((l) => l.includes(ORIGIN));
  s.done();
  expect(origin).toBeGreaterThanOrEqual(0);
  expect(frame.selectedRow).toBeGreaterThanOrEqual(0); // it all fitted, as intended
  const nodes = (def.view as (s: unknown) => ViewNode[])({ cursor }) as ViewNode[];
  return {
    measured: frame.selectedRow - origin,
    counted: focusLineOf(nodes, SIZE.width - 7),
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

test.failing("the stage follows the selection with the arithmetic in host/scroll.ts", () => {
  // `scrollToShow` is the tested, documented, pure version of the follow — and
  // the stage does not call it. It has an inline copy (with a `peek` term the
  // pure one has never heard of), so fixing the rule in scroll.ts fixes
  // nothing on screen, and the tests above pass while the host misbehaves.
  const src = readFileSync(join(import.meta.dir, "..", "host", "stage.ts"), "utf8");
  expect(src.includes("scrollToShow(")).toBe(true);
});

// --- The viewport the follow math thinks it has ----------------------------

test.failing("the viewport the follow math measures is the viewport the frame draws", async () => {
  const s = await session(listApplet());
  const frame = await s.press(0);
  // The follow decides "off screen" against `innerHeight()`, derived from the
  // terminal size minus a chrome constant. The frame is laid out by flexbox.
  // They disagree by a line, so every list starts scrolling a row early.
  expect(s.stage.viewportHeight()).toBe(frame.shown.length);
  s.done();
});

test.failing("the first frame draws as many rows as the second", async () => {
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

  // setFrame lays the CONTENT out before it follows the selection, but reads
  // the viewport's height off the terminal — so on the first frame it is
  // scrolling against a viewport that has not been sized yet.
  expect(first).toBe(second);
});

// --- Rule 2: the view moves only when it has to ----------------------------

test.failing("↓ does not scroll while there is still a row below the selection", async () => {
  const s = await session(listApplet());
  const frames = await s.walkDown(20);
  s.done();

  // The frame BEFORE the first scroll still has room under the cursor: the
  // list moved while the selected row had a drawn row below it.
  const firstScroll = frames.findIndex((f) => f.scrollTop > 0);
  expect(firstScroll).toBeGreaterThan(0);
  const before = frames[firstScroll - 1]!;
  expect(before.lastRow - before.selectedRow).toBe(0);
});

test.failing("an unbordered box above the list does not drag the view with the cursor", async () => {
  // The reported bug, in the smallest shape that shows it: a plain `box` — no
  // border asked for, and the renderer draws none — sitting above a list.
  // `focusLineOf` counts two border lines the frame never drew, so the follow
  // believes the selection is two lines lower than it is, and from there every
  // ↓ scrolls the whole list while the cursor sits parked THREE rows above the
  // bottom of the frame with list still visible underneath it.
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

test.failing("a `col` with a gap keeps the selection on screen", async () => {
  // `gap: 1` draws a blank line between rows; `focusLineOf` counts none of
  // them, so its idea of the selection's line is half the truth. Past the
  // halfway point the follow is convinced the row is still on screen, the view
  // never moves again, and the cursor is simply gone.
  const s = await session(listApplet([], { gap: 1 }));
  const frames = await s.walkDown(20);
  s.done();
  const lost = frames.flatMap((f, i) => (f.selectedRow < 0 ? [i] : []));
  expect(lost).toEqual([]);
});

test.failing("a wrapped line above the list keeps the selection on screen", async () => {
  // One long line — an email subject, a note's first paragraph — wraps to three
  // rows on screen and counts as one in the follow math. Every row below it is
  // two lines lower than the host believes.
  const s = await session(listApplet([text("wrap ".repeat(40))]));
  const frames = await s.walkDown(20);
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

// --- Where the focused row really is ---------------------------------------
//
// One assertion, six shapes: does `focusLineOf` predict the line the renderer
// actually draws the selection on? Everything above is a consequence of these.

test("a plain list: the counted line is the drawn line", async () => {
  const { measured, counted } = await measuredLine([], {}, 5);
  expect(counted).toBe(measured);
});

test("a titled box above the list: counted line is the drawn line", async () => {
  const { measured, counted } = await measuredLine([box([text("a"), text("b")], { title: "hi" })], {}, 5);
  expect(counted).toBe(measured);
});

test.failing("an UNBORDERED box above the list: counted line is the drawn line", async () => {
  // `box()` with no `border` and no `title` renders without a frame
  // (renderables.ts: `o.border ?? o.title !== undefined`) but is counted as
  // bordered (nodes.ts: `border === false ? 0 : 1`). Two phantom lines.
  const { measured, counted } = await measuredLine([box([text("a"), text("b")])], {}, 5);
  expect(counted).toBe(measured);
});

test.failing("a padded box above the list: counted line is the drawn line", async () => {
  // `padding` reaches the renderer through layoutProps and adds a line above
  // and below the box's children. The focus math never looks at it.
  const { measured, counted } = await measuredLine([box([text("a")], { border: true, padding: 1 })], {}, 5);
  expect(counted).toBe(measured);
});

test.failing("a `col` with a gap: counted line is the drawn line", async () => {
  const { measured, counted } = await measuredLine([], { gap: 1 }, 5);
  expect(counted).toBe(measured);
});

test.failing("a wrapping line above the list: counted line is the drawn line", async () => {
  const { measured, counted } = await measuredLine([text("wrap ".repeat(40))], {}, 5);
  expect(counted).toBe(measured);
});

// --- The same three defects, as pure arithmetic ----------------------------
//
// The rendered tests above are the proof; these are the fast red lights to fix
// against. Note that tests/nodes.test.ts asserts the OPPOSITE of the first one
// ("counts a box's borders", with a box the renderer draws no borders for), so
// fixing this means fixing that expectation too.

test.failing("an unbordered box is not counted as two lines of chrome", () => {
  // `box()` with neither `border` nor `title` draws no frame.
  expect(focusLineOf([box([text("a")]), text("row", { focus: true })])).toBe(1);
});

test.failing("a col's gap is counted", () => {
  const rows = [text("a"), text("b"), text("row", { focus: true })];
  expect(focusLineOf([col(rows, { gap: 1 })])).toBe(4);
});

test.failing("a box's padding is counted", () => {
  expect(focusLineOf([box([text("a")], { border: true, padding: 1 }), text("row", { focus: true })])).toBe(5);
});

test.failing("a line that wraps is counted at the height it wraps to", () => {
  // 100 characters in a 37-cell pane is three rows on screen, not one.
  expect(focusLineOf([text("x".repeat(100)), text("row", { focus: true })], 37)).toBe(3);
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

test.failing("↓ through the launcher does not scroll while entries are still below", async () => {
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

  // A launcher entry is two lines (title + summary), so `peek` keeps one line
  // below the selection on screen. Anything MORE than that is the view being
  // dragged along by a cursor that had room to move.
  for (const [i, f] of frames.entries()) {
    if (f.scrollTop === 0) continue;
    expect({ cursor: i, roomBelow: f.lastRow - f.selectedRow }).toEqual({ cursor: i, roomBelow: 1 });
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

test.failing("the wheel and the follow math agree on how tall the viewport is", async () => {
  // Two paths, two answers. `scrollBy` (the wheel) clamps against the
  // ScrollBox's REAL viewport height; the follow (↑↓) measures the viewport
  // itself, off the terminal size. So the bottom of the list is a different
  // place depending on which one put you there — and the follow's answer is
  // the one that is a line short.
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

test.failing("a wheel scroll survives a repaint that did not move the cursor", async () => {
  // The other half of the report: scroll-into-view eating a scroll you made
  // yourself. Wheel down a cursored list to read ahead, and the next repaint —
  // an SSE state push, a poll, anything at all — yanks the view back to the
  // cursor, because the follow re-runs from scratch on every frame with no
  // notion that the human moved the viewport on purpose.
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
