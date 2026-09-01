import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "../core/config.ts";
import { loadPackages, REPO_ROOT } from "../core/load.ts";
import { galleryMarkdown, heroOf, renderShots, SHOTS_DIR, spliceGallery, WINDOW } from "../core/shots.ts";

/**
 * The anti-rot guard for the README gallery.
 *
 * Marketing images go stale silently: someone changes a component, the applet
 * still passes its fixtures, and the README keeps showing a UI that no longer
 * exists. So the committed shots are held to a fresh render of the same hero
 * fixtures — a layout change that alters what an applet looks like fails HERE,
 * loudly, and the fix is one command.
 *
 * The render is pinned (fixed window, fixed clock, fixed timezone, default
 * theme — see core/shots.ts) so a failure only ever means "the UI changed".
 */

const packages = await loadPackages();
const repo = packages.filter((p) => p.source === "repo");
const shots = await renderShots(packages);
const FIX = "run `bun run shots` and commit the result";

test("every applet ships a hero fixture to be shot", async () => {
  const without: string[] = [];
  for (const pkg of repo) if (!(await heroOf(pkg))) without.push(pkg.def.id);
  // An applet with no hero has no portrait in the README — and, more to the
  // point, no fixture at all, so nothing is holding its rendering to anything.
  expect(without).toEqual([]);
  expect(shots).toHaveLength(repo.length);
});

test("the committed shots are what the applets render today", async () => {
  const stale: string[] = [];
  for (const shot of shots) {
    const file = join(REPO_ROOT, shot.path);
    const current = await Bun.file(file)
      .text()
      .catch(() => null);
    if (current === null) stale.push(`${shot.path} (missing)`);
    else if (current !== shot.svg) stale.push(`${shot.path} (out of date)`);
  }
  expect({ stale, fix: FIX }).toEqual({ stale: [], fix: FIX });
});

test("no image is left behind by an applet that is gone", async () => {
  const dir = join(REPO_ROOT, SHOTS_DIR);
  const files = existsSync(dir) ? [...new Bun.Glob("*.svg").scanSync(dir)] : [];
  const keep = new Set(shots.map((s) => `${s.id}.svg`));
  expect(files.filter((f) => !keep.has(f))).toEqual([]);
});

test("the README gallery is generated from the live applet list", async () => {
  const readme = await Bun.file(join(REPO_ROOT, "README.md")).text();
  expect({ readme: spliceGallery(readme, galleryMarkdown(shots)), fix: FIX }).toEqual({ readme, fix: FIX });
  // Every applet is in it, and nothing is hand-placed between the markers.
  for (const pkg of repo) expect(readme).toContain(`${SHOTS_DIR}/${pkg.def.id}.svg`);
});

test("a shot is one fixed window, whoever is in it", () => {
  const sizes = new Set(shots.map((s) => s.svg.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("x")));
  expect([...sizes]).toHaveLength(1);
  expect(WINDOW).toEqual({ cols: 80, rows: 24 });
});

test("a second render is the same render, whatever the machine looks like", async () => {
  // The shots are committed, so a diff has to mean the UI changed. Render the
  // whole set again — later in wall-clock time, in another timezone, against a
  // config.toml that retints everything — and it must come out byte-identical.
  const dir = mkdtempSync(join(tmpdir(), "kona-shots-"));
  writeFileSync(
    join(dir, "config.toml"),
    `[theme]\nbg = "#ffffff"\naccent = "#ff00ff"\ndim = "#00ff00"\nmuted = "#ff0000"\n`,
  );
  const cfg = process.env.KONA_CONFIG_DIR;
  const tz = process.env.TZ;
  process.env.KONA_CONFIG_DIR = dir;
  process.env.TZ = "Asia/Tokyo";
  resetConfig();
  try {
    const again = await renderShots(packages);
    expect(again.map((s) => [s.id, s.svg])).toEqual(shots.map((s) => [s.id, s.svg]));
  } finally {
    if (cfg === undefined) delete process.env.KONA_CONFIG_DIR;
    else process.env.KONA_CONFIG_DIR = cfg;
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  }
});
