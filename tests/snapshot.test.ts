import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPackages } from "../core/load.ts";
import { renderLauncher, testSnapshots, type AppletSnapshot } from "../sdk/testing.ts";
import type { AnyApplet } from "../sdk/index.ts";

/**
 * The rendering regression RUNNER — not a registry.
 *
 * Snapshots used to be a single file every applet appended to, which made two
 * unrelated applets conflict in git over nothing. Now an applet ships its own
 * `snapshots.ts` in its package and this file discovers them the same way the
 * loader discovers the applets themselves. Adding an applet never edits it;
 * adding a fixture never leaves the applet's directory.
 *
 * Each fixture drives the real stage through OpenTUI's headless renderer and
 * asserts on the actual on-screen text — a layout or component change that
 * breaks the visible output fails here, not in your eyes.
 */

const packages = await loadPackages();

test("the launcher lists the applets this machine has, as a menu", async () => {
  const defs = packages.map((p) => p.def);
  // An ORDINARY viewport, not one sized to the list: the launcher scrolls and
  // filters now, so a growing applet count is not this test's problem. What is
  // reachable however long the list gets is tests/launcher.test.ts.
  const frame = await renderLauncher(defs, 0);
  expect(frame).toContain("kona");
  expect(frame).toContain(defs[0]!.title);
  expect(frame).toContain(defs[0]!.summary!.slice(0, 24)); // titles AND what they are
  expect(frame).toContain("▸"); // cursor marker
});

test("every installed applet can be reached by cursor or by typing its name", async () => {
  const defs = packages.map((p) => p.def);
  const timer = defs.findIndex((d) => d.id === "timer");
  expect(timer).toBeGreaterThanOrEqual(0);
  expect(await renderLauncher(defs, timer)).toContain("Timer");
  expect(await renderLauncher(defs, 0, 62, 30, "storybook")).toContain("Storybook");
});

for (const pkg of packages) {
  const file = join(pkg.dir, "snapshots.ts");
  if (!existsSync(file)) continue;
  const snaps = ((await import(file)) as { default?: AppletSnapshot[] }).default ?? [];
  await testSnapshots(pkg.def as AnyApplet, snaps);
}
