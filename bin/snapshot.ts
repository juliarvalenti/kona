#!/usr/bin/env bun
import { renderApplet, renderLauncher } from "../sdk/testing.ts";

/**
 * Render an applet (or the launcher) to plain text — no TTY needed. Lets us
 * *see* the UI in CI, in a pipe, or in an agent's view.
 *
 *   bun run bin/snapshot.ts storybook
 *   bun run bin/snapshot.ts timer '{"timers":[],"cursor":0}'
 *   bun run bin/snapshot.ts --launcher
 *
 * The rendering itself lives in `sdk/testing.ts`, which is also what an
 * applet's own snapshot fixtures and tests use — one code path, so what you see
 * here is what the suite asserts on.
 */
const [target, stateJson] = process.argv.slice(2);
const [w, h] = [Number(process.env.COLS ?? 62), Number(process.env.ROWS ?? 30)];

/** Kept for applets that render inside their own tests. */
export async function snapshot(
  target: string,
  stateOverride?: Record<string, unknown>,
  width = w,
  height = h,
): Promise<string> {
  return target === "--launcher" || target === "launcher"
    ? renderLauncher(undefined, 0, width, height)
    : renderApplet(target, stateOverride, width, height);
}

if (import.meta.main) {
  const state = stateJson ? JSON.parse(stateJson) : undefined;
  console.log(await snapshot(target ?? "--launcher", state));
  process.exit(0);
}
