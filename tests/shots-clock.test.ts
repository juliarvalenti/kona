import { test, expect } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT } from "../core/load.ts";
import { SKEW_MS } from "./fixtures/skew-clock.ts";

/**
 * The committed gallery must not depend on when it was rendered (#66).
 *
 * `tests/shots.test.ts` re-renders the shots in THIS process, which cannot see
 * the failure it is meant to catch: a fixture that stamps itself at import
 * time is already imported, and the wall clock has barely moved since the run
 * started. So the images silently rotted — an applet printing a relative
 * timestamp drew a different frame a day later, and unrelated PRs went red.
 *
 * This runs `bun run shots --check` in a fresh process whose clock says it is
 * weeks from now, halfway around the day. Everything the shots are made of has
 * to come from the pinned epoch, so the answer must still be "up to date".
 */

test("the shots are the same shots on a machine weeks from now", async () => {
  const proc = Bun.spawn(
    ["bun", "--preload", join(REPO_ROOT, "tests/fixtures/skew-clock.ts"), join(REPO_ROOT, "bin/shots.ts"), "--check"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, KONA_CLOCK_SKEW_MS: String(SKEW_MS), KONA_NO_PLUGINS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // On failure the checker names the images that moved, which is the whole
  // diagnosis: those applets are reading the wall clock past the pin.
  expect({ code, out: `${out}${err}`.trim() }).toEqual({ code: 0, out: expect.stringContaining("up to date") });
}, 60_000);
