import { test, expect, afterEach } from "bun:test";
import { providerFetch, setTransport, faked, offline, isLocal } from "../server/transport.ts";
import { fakeProviders, type FakeProviders } from "../sdk/fake.ts";
import * as spotify from "../server/spotify.ts";
import { spotifyRoutes, LAPTOP_ID } from "./fixtures/spotify.ts";

/**
 * The provider seam itself (#41): under test, a call either goes to a fake or
 * goes nowhere. The suite preloads KONA_FAKE_PROVIDERS=1 (tests/setup.ts), so
 * this file asserts the guarantee the whole suite leans on — a `bun test` can
 * never reach a real account, and what a side-effecting verb WOULD have sent is
 * recorded instead of sent.
 */

let fake: FakeProviders | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

test("under test, a live call is blocked before it leaves the machine", async () => {
  expect(offline()).toBe(true);
  expect(faked()).toBe(false); // no fake installed: the network is simply shut
  await expect(providerFetch("spotify", "https://api.spotify.com/v1/me/player")).rejects.toThrow(
    /blocked a live GET https:\/\/api\.spotify\.com/,
  );
});

test("the block names the method and how to get past it", async () => {
  const err = await providerFetch("spotify", "https://api.spotify.com/v1/me/player/volume?volume_percent=100", {
    method: "PUT",
  }).catch((e) => e as Error);
  expect(err.message).toContain("blocked a live PUT");
  expect(err.message).toContain("fakeProviders()");
  expect(err.message).toContain("KONA_LIVE=1");
});

test("a fixture server on localhost is not a live account", async () => {
  expect(isLocal("http://localhost:4177/x")).toBe(true);
  expect(isLocal("http://127.0.0.1:8899/callback")).toBe(true);
  expect(isLocal("https://api.spotify.com/v1")).toBe(false);
  // ...and it goes through: this is how the gmail/outlook/ticker/webex suites
  // already drive the real client code (KONA_GMAIL_API and friends).
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const res = await providerFetch("ticker", `http://localhost:${server.port}/quote`);
  expect(await res.json()).toEqual({ ok: true });
  server.stop(true);
});

test("a fake answers from fixtures and records every call", async () => {
  fake = fakeProviders(spotifyRoutes());
  expect(faked()).toBe(true);

  const now = await spotify.nowPlaying();
  expect(now?.track).toBe("Rave Green");
  expect(now?.artist).toBe("Four Tet");
  expect(now?.device).toBe("MacBook Pro");
  expect(now?.volumePct).toBe(62);
  expect(now?.upNext.map((q) => q.track)).toEqual(["Baby"]);
  expect(now?.context).toBe("Four Tet Radio"); // resolved through /v1/playlists/{id}

  expect(fake.lines()).toContain("GET /v1/me/player");
  expect(fake.from("spotify").length).toBe(fake.calls.length);
});

test("side-effecting verbs are recorded, not executed", async () => {
  fake = fakeProviders(spotifyRoutes());

  await spotify.setVolume(55);
  await spotify.seek(90_000);
  await spotify.transferPlayback(LAPTOP_ID, true);
  await spotify.queueUri("spotify:track:2Fs2VfRfXQP4pFbLNZfBBB");

  // Exactly what would have gone on the wire — the account never hears it.
  expect(fake.lines()).toEqual([
    "PUT /v1/me/player/volume?volume_percent=55",
    "PUT /v1/me/player/seek?position_ms=90000",
    "PUT /v1/me/player",
    "POST /v1/me/player/queue?uri=spotify%3Atrack%3A2Fs2VfRfXQP4pFbLNZfBBB",
  ]);
  const transfer = fake.writes()[2]!;
  expect(transfer.json).toEqual({ device_ids: [LAPTOP_ID], play: true });
  expect(fake.last()!.params.get("uri")).toBe("spotify:track:2Fs2VfRfXQP4pFbLNZfBBB");
});

test("a fake authenticates nothing — no keychain, no token round-trip", async () => {
  fake = fakeProviders(spotifyRoutes());
  expect(await spotify.isAuthed()).toBe(true);
  await spotify.nowPlaying();
  // accounts.spotify.com is where the refresh would go; it never comes up.
  expect(fake.lines().some((l) => l.includes("/api/token"))).toBe(false);
  expect(fake.calls.every((c) => c.headers.authorization === undefined || c.headers.authorization === "<redacted>")).toBe(true);
});

test("a missing read fixture says which one to add", async () => {
  fake = fakeProviders({});
  await expect(spotify.nowPlaying()).rejects.toThrow(/no fixture for spotify GET \/v1\/me\/player/);
});

test("routes can be replaced mid-test, and calls reset", async () => {
  fake = fakeProviders(spotifyRoutes());
  expect((await spotify.devices()).length).toBe(2); // the id-less device is dropped
  fake.reset();
  expect(fake.calls).toEqual([]);

  fake.route({ "GET /v1/me/player/devices": { devices: [] } });
  expect(await spotify.devices()).toEqual([]);
});

test("restore puts the real transport back", () => {
  const handle = fakeProviders({});
  expect(faked()).toBe(true);
  handle.restore();
  handle.restore(); // idempotent — an afterEach may double up
  expect(faked()).toBe(false);
  setTransport(null);
});
