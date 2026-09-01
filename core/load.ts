import { Glob } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppletDef } from "../sdk/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
export const APPLETS_DIR = join(REPO_ROOT, "applets");

/**
 * Discover every applet under applets/<name>/index.ts and load its default
 * export. Both the daemon and the host call this — same modules, different
 * fields consumed.
 */
export async function loadApplets(): Promise<AppletDef[]> {
  const glob = new Glob("*/index.ts");
  const found: AppletDef[] = [];
  for await (const rel of glob.scan({ cwd: APPLETS_DIR })) {
    const mod = await import(join(APPLETS_DIR, rel));
    const def = mod.default as AppletDef | undefined;
    if (def && def.id) found.push(def);
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}
