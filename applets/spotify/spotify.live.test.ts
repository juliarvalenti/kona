import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { allowLive, blockLive } from "../../server/transport.ts";
import { isAuthed, nowPlaying, devices } from "../../server/spotify.ts";

/**
 * The real Spotify, on purpose — the manual half of #41. The default `bun test`
 * SKIPS this file; you run it yourself when you want to know the Web API still
 * answers the way `tests/fixtures/spotify.ts` says it does:
 *
 *   KONA_LIVE=1 bun test applets/spotify/spotify.live.test.ts
 *
 * It takes both the env flag and the explicit `allowLive()` below, so a stray
 * `KONA_LIVE=1 bun test` can't quietly unlock the rest of the suite.
 *
 * READ-ONLY, and it stays that way: nothing here plays, pauses, seeks, sets a
 * volume or moves a device, because a test that changes what a human is
 * listening to is the bug this whole layer exists to prevent. If a fixture
 * looks stale, re-record it from what these reads print.
 */

const live = process.env.KONA_LIVE === "1";

beforeAll(() => {
  if (live) allowLive();
});
afterAll(() => {
  blockLive();
});

describe.skipIf(!live)("spotify (live account)", () => {
  test("we are signed in", async () => {
    expect(await isAuthed()).toBe(true);
  });

  test("now-playing parses, or answers null with nothing playing", async () => {
    const now = await nowPlaying();
    if (!now) return; // nothing playing is a legitimate answer, not a failure
    expect(typeof now.track).toBe("string");
    expect(now.durationMs).toBeGreaterThan(0);
    expect(now.volumePct).toBeGreaterThanOrEqual(0);
    expect(["off", "context", "track"]).toContain(now.repeat);
  });

  test("devices come back with the fields the picker draws", async () => {
    for (const d of await devices()) {
      expect(d.id).toBeTruthy();
      expect(typeof d.name).toBe("string");
      expect(typeof d.supportsVolume).toBe("boolean");
    }
  });
});
