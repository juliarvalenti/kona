import { test, expect } from "bun:test";
import { snapshot } from "../bin/snapshot.ts";

/**
 * Rendering regression tests. These drive the real stage through OpenTUI's
 * headless renderer and assert on the actual on-screen text — so a layout or
 * component change that breaks the visible output fails here, not in your eyes.
 */

test("launcher lists applets with a cursor and title", async () => {
  const frame = await snapshot("--launcher", undefined, 62, 20);
  expect(frame).toContain("kona");
  expect(frame).toContain("Timer");
  expect(frame).toContain("Storybook");
  expect(frame).toContain("▸"); // cursor marker
});

test("timer shows status, label, and a partly-filled bar", async () => {
  const frame = await snapshot(
    "timer",
    { remaining: 125, total: 300, running: true, label: "tea" },
    62,
    24,
  );
  expect(frame).toContain("running");
  expect(frame).toContain("tea");
  expect(frame).toContain("█"); // bar has fill
  expect(frame).toContain("░"); // ...and empty remainder
});

test("storybook renders every component; bars fill mid-sweep", async () => {
  const frame = await snapshot("storybook", { frame: 45 }, 62, 30);
  for (const expected of ["kona components", "[LIVE]", "host", "inbox", "pause/resume"]) {
    expect(frame).toContain(expected);
  }
  expect(frame).toContain("█"); // progress/gauge have fill at frame 45
});
