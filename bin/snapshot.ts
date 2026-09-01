#!/usr/bin/env bun
import { createTestRenderer } from "@opentui/core/testing";
import { loadApplets } from "../core/load.ts";
import { createStage } from "../host/stage.ts";
import type { AppletState } from "../sdk/index.ts";

/**
 * Render an applet (or the launcher) to plain text via OpenTUI's headless test
 * renderer — no TTY needed. Lets us *see* the UI in CI, in a pipe, or in an
 * agent's view, and is the basis for snapshot tests.
 *
 *   bun run bin/snapshot.ts storybook
 *   bun run bin/snapshot.ts timer '{"remaining":125,"total":300,"running":true,"label":"tea"}'
 *   bun run bin/snapshot.ts --launcher
 */
const [target, stateJson] = process.argv.slice(2);
const [w, h] = [Number(process.env.COLS ?? 62), Number(process.env.ROWS ?? 30)];

export async function snapshot(target: string, stateOverride?: Record<string, unknown>, width = w, height = h): Promise<string> {
  const applets = await loadApplets();
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
  const stage = createStage(renderer);

  if (target === "--launcher" || target === "launcher") {
    stage.renderLauncher(applets, 0);
  } else {
    const def = applets.find((a) => a.id === target);
    if (!def) throw new Error(`no such applet: ${target}`);
    const state = { ...def.initialState, ...(stateOverride ?? {}) } as AppletState;
    stage.renderApplet(def, state);
  }
  await renderOnce();
  const frame = captureCharFrame();
  // Each call spins up a renderer; tear it down so a test file full of
  // snapshots doesn't pile up listeners on the shared console cache.
  renderer.destroy();
  return frame;
}

if (import.meta.main) {
  const state = stateJson ? JSON.parse(stateJson) : undefined;
  console.log(await snapshot(target ?? "--launcher", state));
  process.exit(0);
}
