// MUST be set before the applet/server modules load: forces the Spotify
// server's api() to no-op instead of hitting a live account. Without it,
// running this suite on a signed-in machine actually seeks/sets volume on your
// real Spotify (it did — see #41 for the proper provider mock layer).
process.env.KONA_FAKE_PROVIDERS = "1";

import { test, expect } from "bun:test";
import spotify from "../applets/spotify/index.ts";
import type { AppletState } from "../sdk/index.ts";

/**
 * Transport math, exercised through the real verbs. The Web API call is
 * short-circuited (KONA_FAKE_PROVIDERS above) so it lands in state.error — what
 * we assert here is the optimistic state the verb leaves behind, which is what
 * the TUI draws before the API answers.
 */
const st = (over: Record<string, unknown>) => ({ ...spotify.initialState, ...over }) as AppletState;
const call = (verb: string, args: Record<string, unknown>, state: AppletState) =>
  spotify.verbs[verb]!(args, { state, emit: () => {} });

test("seek clamps to the track and moves the bar optimistically", async () => {
  const near = st({ track: "Rave Green", positionMs: 208_000, durationMs: 214_000 });
  await call("seek", { deltaMs: 10_000 }, near);
  expect(near.positionMs).toBe(214_000); // never past the end

  const start = st({ track: "Rave Green", positionMs: 4_000, durationMs: 214_000 });
  await call("seek", { deltaMs: -10_000 }, start);
  expect(start.positionMs).toBe(0); // ...nor before the beginning

  const absolute = st({ track: "Rave Green", positionMs: 4_000, durationMs: 214_000 });
  await call("seek", { positionMs: 90_000 }, absolute);
  expect(absolute.positionMs).toBe(90_000); // agents can jump anywhere
});

test("seek is a no-op with nothing playing", async () => {
  const idle = st({ track: "", positionMs: 0, durationMs: 0 });
  await call("seek", { deltaMs: 10_000 }, idle);
  expect(idle.positionMs).toBe(0);
  expect(idle.error).toBeNull();
});

test("volume nudges and clamps to 0..100", async () => {
  const loud = st({ volumePct: 98, volumeSupported: true });
  await call("volume", { delta: 5 }, loud);
  expect(loud.volumePct).toBe(100);

  const quiet = st({ volumePct: 3, volumeSupported: true });
  await call("volume", { delta: -5 }, quiet);
  expect(quiet.volumePct).toBe(0);

  const exact = st({ volumePct: 20, volumeSupported: true });
  await call("volume", { pct: 55 }, exact);
  expect(exact.volumePct).toBe(55);
});

test("volume says so when the device has no volume control", async () => {
  const fixed = st({ volumePct: 40, volumeSupported: false, device: "Kitchen Speaker" });
  await call("volume", { delta: 5 }, fixed);
  expect(fixed.volumePct).toBe(40); // unchanged
  expect(String(fixed.error)).toContain("Kitchen Speaker");
});
