import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import { resetConfig } from "../core/config.ts";
import { big, box, col, defineApplet, input, row, spacer, text, type AppletDef, type ViewNode } from "../sdk/index.ts";
import theme from "../applets/theme/index.ts";
import { THEME_PRESETS } from "../core/themes.ts";

/**
 * Does the host SEE the selection, wherever an applet put it?
 *
 * One answer decides two things: whether ↑↓ move an applet's cursor or just
 * push the viewport (`hasFocusTarget`), and which row the view follows. So a
 * tree the host fails to search isn't a scrolling nit — it is an applet whose
 * arrow keys stop working.
 *
 * These used to be unit tests on `focusLineOf`, a walk that PREDICTED the line
 * a focused row would land on. It is gone: the stage now finds the widget it
 * built for the focused node and asks the layout where that ended up, so the
 * question "which line?" has no answer to get wrong, and the only question
 * left is the one below — is the focus found at all. Each shape here is a tree
 * that has broken that in the past; how the view then SCROLLS is
 * tests/scroll.test.ts.
 *
 * The theme picker draws the shape that used to break: two lists side by side.
 */

// Point the picker's config reads at a throwaway dir — these tests must not
// depend on (or touch) the palette of the machine running them.
const prevDir = process.env.KONA_CONFIG_DIR;
const dir = mkdtempSync(join(tmpdir(), "kona-nodes-"));
process.env.KONA_CONFIG_DIR = dir;
resetConfig();

afterAll(() => {
  if (prevDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevDir;
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

/** Mount a view on the real stage — the only place the answer is ever read. */
async function mount(nodes: ViewNode[], size = { width: 80, height: 24 }) {
  const def = defineApplet({
    id: "probe",
    title: "probe",
    summary: "a tree with a selection somewhere in it",
    initialState: {},
    verbs: {},
    view: () => nodes,
  }) as unknown as AppletDef;
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(size);
  const stage = createStage(renderer);
  stage.renderApplet(def, {} as never);
  await renderOnce();
  const found = stage.hasFocusTarget();
  const frame = captureCharFrame();
  renderer.destroy();
  return { found, frame };
}

test("finds the focused row in a plain column", async () => {
  const view = [col([text("header"), text("a"), text("b", { focus: true }), text("c")])];
  expect((await mount(view)).found).toBe(true);
});

test("finds a focused cell inside a row", async () => {
  const view = [col([text("header"), row([text("left"), text("right", { focus: true })]), text("after")])];
  expect((await mount(view)).found).toBe(true);
});

test("descends into columns nested in a row — two lists side by side", async () => {
  // The shape the theme picker draws: one row holding two lists, the selection
  // two levels down. A walk that only checked a row's own children called this
  // "no selection" and handed the arrows to the scrollbar.
  const left = col([text("palette"), text("one"), text("two", { focus: true }), text("three")]);
  const right = col([text("figlet"), text("auto"), text("huge")]);
  expect((await mount([col([text("header"), row([left, right])])])).found).toBe(true);
});

test("looks inside a box", async () => {
  expect((await mount([col([text("above"), box([text("inside", { focus: true })])])])).found).toBe(true);
});

test("a field with the keyboard is a focus target too", async () => {
  expect((await mount([col([text("name"), input("who", "ada", { focus: true })])])).found).toBe(true);
});

test("no focus anywhere: ↑↓ scroll the viewport instead", async () => {
  expect((await mount([col([text("a"), spacer(), row([text("b")])])])).found).toBe(false);
});

test("a hero above a list does not push the selection off screen", async () => {
  // A `big` node is many lines tall — six for `huge` — and the rows under it
  // are that much further down. Counting it as one line (or as the wrong face)
  // parked the selection just under the fold.
  const rows = Array.from({ length: 20 }, (_, i) =>
    text(`${i === 12 ? "▸" : " "} row-${String(i).padStart(2, "0")}`, { focus: i === 12 }),
  );
  const { found, frame } = await mount([col([big("kona", undefined, "huge"), ...rows])]);
  expect(found).toBe(true);
  expect(frame).toContain("▸ row-12");
});

test("the theme picker has a focused row on both axes, so arrows move its cursors", async () => {
  const state = { ...structuredClone(theme.initialState), cursor: 3, fontCursor: 2 };
  for (const axis of ["palette", "font"] as const) {
    const nodes = theme.view({ ...state, axis }, { width: 80, height: 24 }) as ViewNode[];
    expect((await mount(nodes)).found).toBe(true);
  }
});

test("the theme picker's selection stays on screen all the way down the list", async () => {
  // The picker is the awkward case: its hero re-letters with the preset under
  // the cursor, so the list itself moves as you walk it. Rendered in a frame
  // too short for the list, every preset still has to be reachable.
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
  const stage = createStage(renderer);
  const lost: string[] = [];
  for (let cursor = 0; cursor < THEME_PRESETS.length; cursor++) {
    stage.renderApplet(theme as never, { ...structuredClone(theme.initialState), cursor } as never);
    await renderOnce();
    const { label } = THEME_PRESETS[cursor]!;
    if (!captureCharFrame().includes(label)) lost.push(label);
  }
  renderer.destroy();
  expect(lost).toEqual([]);
});
