import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "../server/daemon.ts";

const here = dirname(fileURLToPath(import.meta.url));
const KONAD = join(here, "..", "bin", "konad.ts");

export const base = () => `http://localhost:${process.env.KONA_PORT ?? DEFAULT_PORT}`;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(300) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure konad is up; if not, spawn it detached and wait for health.
 * Spawned with `--watch` so editing an applet or server file auto-restarts the
 * daemon — the host auto-reconnects and state is persisted, so it's seamless.
 * (A brand-new applet file is picked up on the next restart, which re-scans.)
 */
export async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  const child = spawn("bun", ["--watch", KONAD], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await healthy()) return;
    await Bun.sleep(100);
  }
  throw new Error("konad did not come up");
}

export async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${base()}${path}`, init);
  return r.json();
}

export async function callVerb(id: string, verb: string, args: Record<string, unknown> = {}) {
  return api(`/applets/${id}/verbs/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}
