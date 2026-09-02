import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import { resetConfig } from "../core/config.ts";
import { big, box, col, row, spacer, text } from "../sdk/index.ts";
import { focusLineOf } from "../host/nodes.ts";
import { fontLines } from "../core/fonts.ts";
import theme from "../applets/theme/index.ts";
import { THEME_PRESETS } from "../core/themes.ts";

/**
 * Where the focused row sits.
 *
 * The host asks `focusLineOf` two questions with one call: which line to scroll
 * to, and — since a null answer means "no selection" — whether ↑↓ should move
 * an applet's cursor at all or just push the viewport. So a tree it fails to
 * search isn't a scrolling nit: it is an applet whose arrow keys stop working.
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

test("finds the focused row in a plain column, counting the rows above it", () => {
  const view = [col([text("header"), text("a"), text("b", { focus: true }), text("c")])];
  expect(focusLineOf(view)).toBe(2);
});

test("a hero counts the lines it actually draws, not one", () => {
  const view = [col([big("kona", undefined, "huge"), text("row", { focus: true })])];
  expect(focusLineOf(view)).toBe(fontLines("huge"));
});

test("finds a focused cell in a row, and the row is one line", () => {
  const view = [col([text("header"), row([text("left"), text("right", { focus: true })]), text("after")])];
  expect(focusLineOf(view)).toBe(1);
});

test("descends into columns nested in a row — two lists side by side", () => {
  // The shape the theme picker draws: one row holding two lists, the selection
  // two levels down. A walk that only checked a row's own children called this
  // "no selection" and handed the arrows to the scrollbar.
  const left = col([text("palette"), text("one"), text("two", { focus: true }), text("three")]);
  const right = col([text("figlet"), text("auto"), text("huge")]);
  expect(focusLineOf([col([text("header"), row([left, right])])])).toBe(3);
});

test("a row of columns is as tall as its tallest column", () => {
  const left = col([text("a"), text("b"), text("c")]);
  const right = col([text("d")]);
  const view = [col([row([left, right]), text("below", { focus: true })])];
  expect(focusLineOf(view)).toBe(3);
});

test("counts a box's borders, and looks inside it", () => {
  const view = [col([text("above"), box([text("inside", { focus: true })])])];
  expect(focusLineOf(view)).toBe(2); // header, top border, then the row
  const after = [col([box([text("inside")]), text("below", { focus: true })])];
  expect(focusLineOf(after)).toBe(3); // border, row, border
});

test("no focus anywhere is null — a plain document scrolls instead", () => {
  expect(focusLineOf([col([text("a"), spacer(), row([text("b")])])])).toBeNull();
});

test("the theme picker has a focused row on both axes, so arrows move its cursors", () => {
  const state = { ...structuredClone(theme.initialState), cursor: 3, fontCursor: 2 };
  for (const axis of ["palette", "font"] as const) {
    const nodes = theme.view({ ...state, axis }, { width: 80, height: 24 }) as ReturnType<typeof col>[];
    expect(focusLineOf(nodes, 80)).not.toBeNull();
  }
});

test("the theme picker's focus follows the palette cursor down the list", () => {
  // Pin a figlet: on `auto` the hero re-letters with the preset under the
  // cursor, and a taller face would move the whole list, not just the cursor.
  const at = (cursor: number) =>
    focusLineOf(
      theme.view({ ...structuredClone(theme.initialState), cursor, fontCursor: 1 }, { width: 80, height: 24 }),
      80,
    );
  const top = at(0)!;
  expect(at(1)).toBe(top + 1);
  expect(at(THEME_PRESETS.length - 1)).toBe(top + THEME_PRESETS.length - 1);
});

test("mounted on the real stage, the theme picker reports a focus target", async () => {
  // What the host actually branches on: with no focus target, ↑↓ fall through
  // to `stage.scrollBy` and the picker's cursors never move.
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 });
  const stage = createStage(renderer);
  stage.renderApplet(theme as never, structuredClone(theme.initialState) as never);
  await renderOnce();
  expect(stage.hasFocusTarget()).toBe(true);
  renderer.destroy();
});
