import { Glob } from "bun";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyApplet, AppletDef } from "../sdk/index.ts";
import { configDir, loadConfig } from "./config.ts";

/**
 * The plugin loader.
 *
 * An applet is a PACKAGE, not an entry in a registry: a directory with an
 * `index.ts` that default-exports `defineApplet(...)`, plus whatever else it
 * needs (tests, snapshot fixtures, a README). Everything kona knows about an
 * applet it learns from that directory — so adding one is `mkdir` + one file,
 * and two people adding two applets never touch the same line.
 *
 * Packages are discovered, never listed:
 *   1. `applets/<name>/` in this repo — what ships with kona.
 *   2. `~/.config/kona/plugins/<name>/` — installed plugins.
 *   3. `plugins = [...]` in config.toml, and `KONA_PLUGINS` (colon-separated).
 *      Each entry is either one package (a dir with an `index.ts`) or a dir
 *      full of them.
 *
 * Ids are unique: the first package to claim an id wins and a later duplicate
 * is skipped with a warning, so a broken plugin can never shadow a built-in.
 * `KONA_NO_PLUGINS=1` limits the scan to the repo (the test suite sets it, so a
 * developer's installed plugins can't change what the suite sees).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
export const APPLETS_DIR = join(REPO_ROOT, "applets");

/** Where an applet package came from. */
export type AppletSource = "repo" | "plugin";

/**
 * A loaded applet and the directory it lives in. The dir is the interesting
 * half for everything that discovers files *next to* an applet — its snapshot
 * fixtures, its README — which is how those stopped being central registries.
 */
export interface AppletPackage {
  def: AnyApplet;
  /** Absolute path of the package directory. */
  dir: string;
  /** Absolute path of the entry module. */
  entry: string;
  source: AppletSource;
}

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Extra roots to scan, in the order they are consulted: the standard plugin
 * dir, then config.toml's `plugins`, then `KONA_PLUGINS`. Paths may be
 * relative (to the cwd) and may start with `~`.
 */
export function pluginRoots(): string[] {
  if (process.env.KONA_NO_PLUGINS === "1") return [];
  const out: string[] = [join(configDir(), "plugins")];
  for (const p of loadConfig().plugins) out.push(resolve(expandHome(p)));
  for (const p of (process.env.KONA_PLUGINS ?? "").split(":")) {
    if (p.trim()) out.push(resolve(expandHome(p.trim())));
  }
  return [...new Set(out)];
}

/** The package dirs under one root — or the root itself, if it is a package. */
async function packageDirs(root: string): Promise<string[]> {
  if (!isDir(root)) return [];
  if (existsSync(join(root, "index.ts"))) return [root];
  const dirs: string[] = [];
  for await (const rel of new Glob("*/index.ts").scan({ cwd: root })) {
    dirs.push(join(root, dirname(rel)));
  }
  return dirs.sort();
}

/**
 * Every applet package on this machine, repo first. Loading is the only place
 * that turns a directory into an applet — the daemon, the host, the CLI, the
 * docs and the test runner all start here.
 */
export async function loadPackages(): Promise<AppletPackage[]> {
  const roots: Array<[string, AppletSource]> = [[APPLETS_DIR, "repo"]];
  for (const r of pluginRoots()) roots.push([r, "plugin"]);

  const found: AppletPackage[] = [];
  const seen = new Set<string>();
  for (const [root, source] of roots) {
    for (const dir of await packageDirs(root)) {
      const entry = join(dir, "index.ts");
      let def: AnyApplet | undefined;
      try {
        def = ((await import(entry)) as { default?: AnyApplet }).default;
      } catch (e) {
        // A plugin that throws on import is skipped, never fatal: kona still
        // boots with everything else installed.
        console.error(`kona: could not load ${entry}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!def?.id) continue;
      if (seen.has(def.id)) {
        console.error(`kona: ignoring ${entry} — applet id "${def.id}" is already loaded`);
        continue;
      }
      seen.add(def.id);
      found.push({ def, dir, entry, source });
    }
  }
  found.sort((a, b) => a.def.id.localeCompare(b.def.id));
  return found;
}

/**
 * The applets themselves. Both the daemon and the host call this — same
 * modules, different fields consumed.
 */
export async function loadApplets(): Promise<AppletDef[]> {
  return (await loadPackages()).map((p) => p.def);
}
