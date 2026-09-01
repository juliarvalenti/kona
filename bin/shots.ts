#!/usr/bin/env bun
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPackages, REPO_ROOT } from "../core/load.ts";
import { galleryMarkdown, renderShots, SHOTS_DIR, spliceGallery, WINDOW } from "../core/shots.ts";

/**
 * Regenerate the README's applet gallery — one image per applet, all the same
 * size, straight from the hero fixture the test suite already asserts on.
 *
 *   bun run shots            # write docs/shots/*.svg and splice the README
 *   bun run shots --check    # say what is stale, write nothing (what CI does)
 *
 * The images are committed; `tests/shots.test.ts` fails when they no longer
 * match a fresh render, so a UI change breaks the build instead of quietly
 * leaving stale pictures in the README.
 */

const check = process.argv.includes("--check");

// Hermetic by construction: the gallery is this repo's applets, never the
// plugins the developer running it happens to have installed.
process.env.KONA_NO_PLUGINS = "1";

const packages = await loadPackages();
const shots = await renderShots(packages);
const dir = join(REPO_ROOT, SHOTS_DIR);
const readmePath = join(REPO_ROOT, "README.md");
const readme = await Bun.file(readmePath).text();
const wanted = spliceGallery(readme, galleryMarkdown(shots));

const stale: string[] = [];
for (const shot of shots) {
  const file = join(REPO_ROOT, shot.path);
  const current = await Bun.file(file)
    .text()
    .catch(() => null);
  if (current === shot.svg) continue;
  stale.push(shot.path);
  if (!check) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, shot.svg);
  }
}

// An applet that was deleted (or renamed) leaves its image behind.
const keep = new Set(shots.map((s) => `${s.id}.svg`));
const orphans = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".svg") && !keep.has(f));
for (const f of orphans) {
  stale.push(`${SHOTS_DIR}/${f} (orphan)`);
  if (!check) await rm(join(dir, f));
}

if (wanted !== readme) {
  stale.push("README.md (gallery)");
  if (!check) await writeFile(readmePath, wanted);
}

const missing = packages.filter((p) => p.source === "repo" && !shots.some((s) => s.id === p.def.id));
for (const p of missing) console.error(`kona: ${p.def.id} has no hero fixture (applets/${p.def.id}/snapshots.ts)`);

const size = `${WINDOW.cols}x${WINDOW.rows}`;
if (check) {
  if (stale.length) {
    console.error(`stale (run \`bun run shots\`):\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${shots.length} shots at ${size} — up to date`);
} else {
  console.log(
    stale.length
      ? `${shots.length} shots at ${size}; updated:\n  ${stale.join("\n  ")}`
      : `${shots.length} shots at ${size} — already up to date`,
  );
}
process.exit(0);
