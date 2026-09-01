import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import { launcherKey, startsFilter } from "../host/index.ts";
import { edit } from "../host/editor.ts";
import { filterApplets } from "../core/catalog.ts";
import { defineApplet, type AppletDef } from "../sdk/index.ts";

/**
 * The launcher has to SCALE. It is the one screen whose length is the applet
 * count, so it is the one screen that outgrows the terminal on its own — and it
 * did: with a dozen applets the tail of the list was unreachable, and the fix
 * kept being "render the tests in a taller viewport". These tests deliberately
 * use a viewport SHORTER than the list, so growth can never quietly push an
 * applet out of reach again.
 */

/** `n` applets, numbered so every title is a unique substring ("App 07"). */
function many(n: number): AppletDef[] {
  return Array.from({ length: n }, (_, i) => {
    const num = String(i).padStart(2, "0");
    return defineApplet({
      id: `app-${num}`,
      title: `App ${num}`,
      summary: `what app ${num} is for`,
      icon: "◆",
      tint: "#7aa2f7",
      initialState: {},
      verbs: {},
      view: () => [],
    }) as AppletDef;
  });
}

/** One launcher frame, drawn through the real stage with no TTY. */
async function draw(
  applets: AppletDef[],
  cursor: number,
  opts: { query?: string; total?: number } = {},
  size = { width: 60, height: 20 },
) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(size);
  const stage = createStage(renderer);
  stage.renderLauncher(applets, cursor, opts);
  await renderOnce();
  const frame = captureCharFrame();
  const scrollTop = stage.scrollTop();
  renderer.destroy();
  return { frame, scrollTop };
}

test("a launcher longer than the terminal scrolls to keep the cursor visible", async () => {
  const applets = many(30);

  const top = await draw(applets, 0);
  expect(top.frame).toContain("App 00");
  expect(top.frame).not.toContain("App 29"); // the list really is taller than the frame
  expect(top.scrollTop).toBe(0);

  const bottom = await draw(applets, 29);
  expect(bottom.frame).toContain("App 29");
  expect(bottom.frame).not.toContain("App 00"); // it followed the cursor down
  expect(bottom.scrollTop).toBeGreaterThan(0);
});

test("paging down through every applet keeps the selection on screen", async () => {
  // The regression itself: whatever the applet count, the row under the cursor
  // is on screen — with its summary line, not hanging off the bottom edge.
  const applets = many(30);
  for (let cursor = 0; cursor < applets.length; cursor++) {
    const { frame } = await draw(applets, cursor);
    const num = String(cursor).padStart(2, "0");
    expect(`cursor ${num}: ${frame}`).toContain(`App ${num}`);
    expect(`cursor ${num}: ${frame}`).toContain(`what app ${num} is for`);
  }
});

test("the launcher shows a wordmark, the applet count, and each app's glyph and summary", async () => {
  const { frame } = await draw(many(3), 0, { total: 3 });
  expect(frame).toContain("kona"); // the frame title; the wordmark itself is ASCII art
  expect(frame).toContain("3 apps");
  expect(frame).toContain("◆"); // per-applet glyph
  expect(frame).toContain("App 00");
  expect(frame).toContain("what app 00 is for"); // the menu reads as a menu
  expect(frame).toContain("▸"); // cursor marker
});

test("a filtered launcher says what it filtered, and an empty result says so", async () => {
  const applets = many(30);
  const hits = filterApplets(applets, "app 07");

  const { frame } = await draw(hits, 0, { query: "app 07", total: applets.length });
  expect(frame).toContain("1/30 matching");
  expect(frame).toContain("App 07");
  expect(frame).not.toContain("App 08");

  const empty = await draw(filterApplets(applets, "nope"), 0, { query: "nope", total: applets.length });
  expect(empty.frame).toContain("0/30 matching");
  expect(empty.frame).toContain("nothing matches");
});

test("the filter matches title, id and summary, and ignores case and space", async () => {
  const applets = many(12);
  expect(filterApplets(applets, "")).toHaveLength(12); // no query, no filtering
  expect(filterApplets(applets, "  APP 03 ").map((a) => a.id)).toEqual(["app-03"]);
  expect(filterApplets(applets, "app-11").map((a) => a.id)).toEqual(["app-11"]);
  expect(filterApplets(applets, "what app 09").map((a) => a.id)).toEqual(["app-09"]); // summary
  expect(filterApplets(applets, "nothing here")).toEqual([]);
});

test("typing opens the filter, but the movement keys still move", () => {
  expect(startsFilter({ name: "s", sequence: "s" })).toBe(true);
  expect(startsFilter({ name: "/", sequence: "/" })).toBe(true);
  expect(startsFilter({ name: "7", sequence: "7" })).toBe(true);

  // hjkl are navigation until a filter is open — `/` is how you filter for one.
  for (const key of ["h", "j", "k", "l"]) expect(startsFilter({ name: key, sequence: key })).toBe(false);
  for (const key of ["up", "down", "left", "right", "return", "escape", "backspace"]) {
    expect(startsFilter({ name: key })).toBe(false);
  }
  expect(startsFilter({ name: "c", ctrl: true, sequence: "\x03" })).toBe(false);
  expect(startsFilter({ name: "space", sequence: " " })).toBe(false); // too easy to hit
});

test("the launcher keyboard: move, wrap, open", () => {
  const view = { count: 4, cursor: 0, filter: null };
  expect(launcherKey(view, { name: "down" })).toEqual({ kind: "move", cursor: 1 });
  expect(launcherKey(view, { name: "j" })).toEqual({ kind: "move", cursor: 1 });
  expect(launcherKey(view, { name: "up" })).toEqual({ kind: "move", cursor: 3 }); // wraps
  expect(launcherKey({ ...view, cursor: 3 }, { name: "down" })).toEqual({ kind: "move", cursor: 0 });
  expect(launcherKey({ ...view, cursor: 2 }, { name: "return" })).toEqual({ kind: "open", index: 2 });
  expect(launcherKey({ count: 0, cursor: 0, filter: null }, { name: "return" })).toEqual({ kind: "none" });
});

test("typing opens the filter with the letter you typed, and `/` opens an empty one", () => {
  const view = { count: 14, cursor: 3, filter: null };
  expect(launcherKey(view, { name: "m", sequence: "m" })).toEqual({
    kind: "filter",
    edit: edit("m"),
    cursor: 0,
  });
  expect(launcherKey(view, { name: "/", sequence: "/" })).toEqual({
    kind: "filter",
    edit: edit(""),
    cursor: 0,
  });
});

test("an open filter takes the letters — but ↑↓ still move and enter still opens", () => {
  const open = { count: 3, cursor: 1, filter: edit("ma") };
  expect(launcherKey(open, { name: "i", sequence: "i" })).toEqual({
    kind: "filter",
    edit: edit("mai"),
    cursor: 0,
  });
  // vim keys are text now; the arrows still navigate the matches
  expect(launcherKey(open, { name: "j", sequence: "j" })).toMatchObject({ kind: "filter" });
  expect(launcherKey(open, { name: "down" })).toEqual({ kind: "move", cursor: 2 });
  expect(launcherKey(open, { name: "return" })).toEqual({ kind: "open", index: 1 });
});

test("esc clears the filter, and so does backspacing out of an empty one", () => {
  expect(launcherKey({ count: 3, cursor: 0, filter: edit("ma") }, { name: "escape" })).toEqual({
    kind: "filter",
    edit: null,
    cursor: 0,
  });
  expect(launcherKey({ count: 14, cursor: 0, filter: edit("") }, { name: "backspace" })).toEqual({
    kind: "filter",
    edit: null,
    cursor: 0,
  });
  // ...but backspace with something to delete just deletes it
  expect(launcherKey({ count: 3, cursor: 0, filter: edit("ma") }, { name: "backspace" })).toEqual({
    kind: "filter",
    edit: edit("m"),
    cursor: 0,
  });
});
