/**
 * One choke point for every outbound provider call.
 *
 * Provider modules (`spotify.ts`, `google.ts`, `weather.ts`, …) never call
 * `fetch` directly — they call `providerFetch()`. That buys two things:
 *
 *   - **A fake can be injected.** `setTransport()` swaps in a function that
 *     answers from fixtures and records what would have been sent, so a test
 *     asserts "spotify would have PUT /v1/me/player/volume?volume_percent=55"
 *     instead of actually turning the human's music down. `sdk/fake.ts` is the
 *     test-facing wrapper; nothing here knows about tests.
 *   - **Live calls are blocked by default under test.** `bun test` preloads
 *     `tests/setup.ts`, which sets `KONA_FAKE_PROVIDERS=1`; from then on any
 *     call to a non-loopback host throws instead of leaving the machine. This
 *     is the backstop that made #41 worth doing: a `bun test` on a signed-in
 *     machine used to fire real seek/volume/transfer at a live Spotify.
 *
 * A localhost URL is always allowed through, because a fixture server a test
 * started itself is by definition not a live account — that is how the gmail,
 * outlook, ticker and webex tests already work (`KONA_GMAIL_API` and friends).
 */

/** What a provider is about to send, in the shape a fake wants to match on. */
export interface ProviderCall {
  /** Provider id — "spotify", "gmail", "weather", … (what the fake groups by). */
  provider: string;
  method: string;
  /** Full URL, as it would go on the wire. */
  url: string;
  /** Pathname + query, the part a route matches ("/v1/me/player?market=US"). */
  path: string;
  headers: Record<string, string>;
  /** Request body when it is a string (JSON or form-encoded), else null. */
  body: string | null;
}

/** A stand-in for the network: answers a call without making it. */
export type Transport = (call: ProviderCall) => Promise<Response>;

let installed: Transport | null = null;

/** Install a fake (or null to restore the network). Returns the previous one. */
export function setTransport(t: Transport | null): Transport | null {
  const prev = installed;
  installed = t;
  return prev;
}

/** True when a fake transport is in place — no call can reach the network. */
export function faked(): boolean {
  return installed !== null;
}

let allowed = false;

/**
 * Open the network back up for the file that asks — how a `*.live.test.ts`
 * talks to the real provider on purpose. It takes BOTH: `KONA_LIVE=1` in the
 * environment and this call, so `KONA_LIVE=1 bun test` on its own still can't
 * let an ordinary test loose on a real account. Pair it with `blockLive()` in
 * an `afterAll`.
 */
export function allowLive(): void {
  if (process.env.KONA_LIVE !== "1") {
    throw new Error("live provider calls need KONA_LIVE=1 — e.g. `KONA_LIVE=1 bun test applets/spotify`");
  }
  allowed = true;
}

/** Shut it again. */
export function blockLive(): void {
  allowed = false;
}

/**
 * True when live provider calls are off limits: the test preload sets
 * `KONA_FAKE_PROVIDERS=1` (tests/setup.ts) and nothing has called
 * `allowLive()`.
 */
export function offline(): boolean {
  return process.env.KONA_FAKE_PROVIDERS === "1" && !allowed;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/i;

/** A fixture server a test started on localhost is not a live account. */
export function isLocal(url: string): boolean {
  return LOOPBACK.test(url);
}

function describe(provider: string, url: string, init?: RequestInit): ProviderCall {
  const u = new URL(url);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => {
    // The token is an implementation detail of auth, and printing it in a
    // recorded call is how secrets end up in CI logs.
    headers[k] = k.toLowerCase() === "authorization" ? "<redacted>" : v;
  });
  return {
    provider,
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    path: u.pathname + u.search,
    headers,
    body: typeof init?.body === "string" ? init.body : null,
  };
}

/**
 * Make a provider call — through the installed fake if there is one, else the
 * network, unless we are under test and the host isn't local.
 */
export async function providerFetch(provider: string, url: string | URL, init?: RequestInit): Promise<Response> {
  const href = String(url);
  const transport = installed;
  if (transport) return transport(describe(provider, href, init));
  assertAllowed(provider, href, init?.method);
  return fetch(href, init);
}

/**
 * Throw unless this call may actually be made. `providerFetch` calls it for
 * you; a provider calls it FIRST, before reading a credential, when the honest
 * failure is "you are under test" rather than "your keychain is empty" — the
 * test then reads the same on a signed-out machine as on a signed-in one.
 */
export function assertAllowed(provider: string, url: string, method = "GET"): void {
  if (installed || !offline() || isLocal(url)) return;
  throw new Error(
    `${provider}: blocked a live ${method.toUpperCase()} ${url} — tests never touch a real account. ` +
      `Install a fake with fakeProviders() (sdk/fake.ts), point the provider's *_API env at a ` +
      `local fixture server, or run the opt-in live suite (allowLive(), KONA_LIVE=1).`,
  );
}

/**
 * The token half of the same seam. A fake transport authenticates nothing, so
 * providers ask for this instead of reaching into the keychain — no live
 * credential is read, and no refresh round-trip is made, under a fake.
 */
export const FAKE_TOKEN = "fake-access-token";
