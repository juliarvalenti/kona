import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "../server/daemon.ts";
import { trustHeaders } from "./trust.ts";

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

// Serialize spawns within a process so a burst of calls can't race into
// multiple daemons.
let spawning: Promise<void> | null = null;

/**
 * Make sure konad is up; if not, spawn ONE plain detached process and wait for
 * health. (Not `--watch` — that leaves a persistent supervisor, and repeated
 * spawns during restarts pile up into dozens of daemons all polling APIs. Use
 * `kona dev` for a watched daemon; new applets are picked up via the daemon's
 * own applets-dir watcher.)
 */
export async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  if (spawning) return spawning;
  spawning = (async () => {
    if (await healthy()) return;
    const child = spawn("bun", ["run", KONAD], { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 50; i++) {
      if (await healthy()) return;
      await Bun.sleep(100);
    }
    throw new Error("konad did not come up");
  })();
  try {
    await spawning;
  } finally {
    spawning = null;
  }
}

export async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${base()}${path}`, init);
  return r.json();
}

/**
 * Ask a running daemon to load an applet module now. Used by `kona <path>` so
 * an executable applet is callable the moment you run it, instead of after the
 * daemon's next restart.
 */
export async function registerApplet(entry: string): Promise<{ id?: string; added?: boolean; error?: string }> {
  return api("/applets/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry }),
  }) as Promise<{ id?: string; added?: boolean; error?: string }>;
}

/**
 * Fire a verb.
 *
 * `trusted` is the whole human-in-the-loop seam from the client side: pass it
 * when a PRESENT HUMAN caused this call — a keypress in the TUI, `kona timer
 * 5m`, an approval from `kona approvals` — and the daemon runs the verb
 * outright. Leave it off for the agent path (`kona call`), where a guarded verb
 * comes back `{ pending }` for a human to approve. See core/trust.ts.
 */
export async function callVerb(
  id: string,
  verb: string,
  args: Record<string, unknown> = {},
  opts: { trusted?: boolean } = {},
) {
  return api(`/applets/${id}/verbs/${verb}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.trusted ? trustHeaders() : {}),
    },
    body: JSON.stringify(args),
  });
}
