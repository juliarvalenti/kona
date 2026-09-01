// Belt and braces: the suite preload (tests/setup.ts) already sets this, but a
// lone `bun test applets/spotify/spotify.test.ts --preload=""` must be safe
// too. With it, `server/transport.ts` refuses any call that would leave the
// machine — running this file on a signed-in machine once actually seeked and
// set the volume on the human's real Spotify (#41).
process.env.KONA_FAKE_PROVIDERS = "1";

import { test, expect, describe, afterEach } from "bun:test";
import spotify from "./index.ts";
import { fakeProviders, type FakeProviders } from "../../sdk/fake.ts";
import { spotifyRoutes, SPEAKER_ID, TRACK_URI } from "../../tests/fixtures/spotify.ts";


/**
 * Two halves.
 *
 * Below: transport math, exercised through the real verbs with NO fake
 * installed — the Web API call is blocked, lands in state.error, and what we
 * assert is the optimistic state the verb leaves behind, which is what the TUI
 * draws before the API answers.
 *
 * Further down: the same verbs against a fake Spotify, where the assertion is
 * the command that would have gone on the wire.
 */
type SpotifyState = typeof spotify.initialState;

const st = (over: Record<string, unknown>) => ({ ...spotify.initialState, ...over }) as SpotifyState;
const call = (verb: string, args: Record<string, unknown>, state: SpotifyState) =>
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

test("queue needs something to queue, and says so", async () => {
  const idle = st({ mode: "now", track: "Rave Green" });
  const res = (await call("queue", {}, idle)) as { queued: boolean; error?: string };
  expect(res.queued).toBe(false);
  expect(String(idle.error)).toContain("uri");
});

test("queue takes the track under the cursor while browsing (the `q` key)", async () => {
  const browsing = st({
    mode: "browse",
    stack: [
      {
        title: "search: four tet",
        cursor: 1,
        rows: [
          { kind: "artist", id: "a1", uri: "spotify:artist:a1", name: "Four Tet", subtitle: "" },
          { kind: "track", id: "t1", uri: "spotify:track:t1", name: "Rave Green", subtitle: "Four Tet" },
        ],
      },
    ],
  });
  const res = (await call("queue", {}, browsing)) as { queued: boolean };
  // No fake here, so the blocked call lands in state.error — what matters is
  // that the verb RESOLVED the selection instead of refusing for want of
  // arguments. The next section asserts the request it resolved to.
  expect(res.queued).toBe(false);
  expect(String(browsing.error)).toContain("blocked a live POST");
});

// --- against a fake Spotify --------------------------------------------------

/**
 * The verbs, driven end to end against recorded payloads: state comes back
 * parsed from a real response shape, and every playback command is recorded
 * rather than sent. This is the test that would have caught #41 — the
 * assertion is literally "what would we have POSTed", so a verb that starts
 * touching an account it shouldn't shows up as a line here.
 */
describe("against a fake Spotify", () => {
  let fake: FakeProviders | null = null;
  afterEach(() => {
    fake?.restore();
    fake = null;
  });

  test("refresh parses now-playing out of a real response shape", async () => {
    fake = fakeProviders(spotifyRoutes());
    const state = st({});
    await call("refresh", {}, state);

    expect(state.track).toBe("Rave Green");
    expect(state.artist).toBe("Four Tet");
    expect(state.album).toBe("Sixteen Oceans");
    expect(state.device).toBe("MacBook Pro");
    expect(state.volumePct).toBe(62);
    expect(state.durationMs).toBe(214_000);
    expect(state.error).toBeNull();
    expect(fake.writes()).toEqual([]); // a read-only verb writes nothing
  });

  test("volume sends the clamped percent and nothing else", async () => {
    fake = fakeProviders(spotifyRoutes());
    await call("volume", { pct: 120 }, st({ volumeSupported: true, volumePct: 40 }));

    expect(fake.writes().map((c) => c.line)).toEqual(["PUT /v1/me/player/volume?volume_percent=100"]);
  });

  test("seek sends an absolute position, clamped to the track", async () => {
    fake = fakeProviders(spotifyRoutes());
    await call("seek", { deltaMs: 10_000 }, st({ track: "Rave Green", positionMs: 208_000, durationMs: 214_000 }));

    expect(fake.writes().map((c) => c.line)).toEqual(["PUT /v1/me/player/seek?position_ms=214000"]);
  });

  test("queue resolves free text to a uri and queues that", async () => {
    fake = fakeProviders(spotifyRoutes());
    const state = st({ mode: "now" });
    const res = (await call("queue", { q: "four tet rave green" }, state)) as { queued: boolean; track?: string };

    expect(res.queued).toBe(true);
    expect(state.error).toBeNull();
    expect(fake.writes().map((c) => c.line)).toEqual([`POST /v1/me/player/queue?uri=${encodeURIComponent(TRACK_URI)}`]);
  });

  test("transfer hands playback to the named device", async () => {
    fake = fakeProviders(spotifyRoutes());
    const state = st({ playing: true });
    await call("transfer", { name: "kitchen" }, state);

    const write = fake.writes()[0]!;
    expect(write.line).toBe("PUT /v1/me/player");
    expect(write.json).toEqual({ device_ids: [SPEAKER_ID], play: true });
    expect(state.error).toBeNull();
  });
});
