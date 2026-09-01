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

test("the launcher lists applets with a cursor and title", async () => {
  // Tall enough to show the whole launcher list as the applet count grows.
  const frame = await renderLauncher(
    packages.map((p) => p.def),
    0,
    62,
    40,
  );
  expect(frame).toContain("kona");
  expect(frame).toContain("Timer");
  expect(frame).toContain("Storybook");
  expect(frame).toContain("▸"); // cursor marker
});

for (const pkg of packages) {
  const file = join(pkg.dir, "snapshots.ts");
  if (!existsSync(file)) continue;
  const snaps = ((await import(file)) as { default?: AppletSnapshot[] }).default ?? [];
  await testSnapshots(pkg.def as AnyApplet, snaps);
}
