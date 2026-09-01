import { setTransport, type ProviderCall, type Transport } from "../server/transport.ts";

/**
 * The provider test kit — the other half of `sdk/testing.ts`.
 *
 * `renderApplet` lets you assert what an applet DRAWS; `fakeProviders` lets you
 * assert what it would SEND. Install a fake, drive the real verbs, then read
 * the recorded calls:
 *
 *   const fake = fakeProviders(spotifyRoutes());
 *   await spotify.verbs.volume!({ pct: 55 }, ctx);
 *   expect(fake.lines()).toContain("PUT /v1/me/player/volume?volume_percent=55");
 *   fake.restore();
 *
 * Nothing leaves the machine: `server/transport.ts` routes every provider call
 * here instead of to `fetch`. Side-effecting verbs are *recorded*, not
 * executed — an unrouted write answers 204 the way Spotify's own player
 * endpoints do, so the verb takes its success path while the account it would
 * have changed never hears about it.
 */

/** One call a provider tried to make, with its body already parsed. */
export interface RecordedCall extends ProviderCall {
  /** The body parsed as JSON, when it was JSON; null otherwise. */
  json: any;
  /** Query parameters, for asserting on one value rather than a whole URL. */
  params: URLSearchParams;
  /** "PUT /v1/me/player/volume?volume_percent=55" — what `lines()` returns. */
  line: string;
}

/** What a route answers with: a Response, or a value we JSON-encode for you. */
export type RouteResult = Response | Record<string, unknown> | unknown[] | string | number | boolean | null | undefined | void;
export type RouteFn = (call: RecordedCall) => RouteResult | Promise<RouteResult>;
/**
 * Routes are keyed `"<METHOD> <path>"`, where the path may end in `*`:
 *
 *   "GET /v1/me/player":       player,          // a canned body
 *   "GET /v1/playlists/*":     (c) => …,        // or a function of the call
 *   "*":                       fallback,        // anything unmatched
 */
export type Routes = Record<string, RouteFn | Exclude<RouteResult, void>>;

export interface FakeProviders {
  /** Every call, in the order the code made them. */
  readonly calls: RecordedCall[];
  /** `"METHOD /path?query"` for each call — the compact form to assert on. */
  lines(): string[];
  /** Calls that would have CHANGED something (POST/PUT/PATCH/DELETE). */
  writes(): RecordedCall[];
  /** Just one provider's calls, when a test drives more than one. */
  from(provider: string): RecordedCall[];
  /** The last call, for a one-call assertion. */
  last(): RecordedCall | undefined;
  /** Add or replace routes mid-test (a second page, an error on retry). */
  route(routes: Routes): void;
  /** Forget the calls so far, keeping the routes. */
  reset(): void;
  /** Put the real network back. Safe to call twice. */
  restore(): void;
  /** So a test can `using fake = fakeProviders(...)`. */
  [Symbol.dispose](): void;
}

function toResponse(result: RouteResult): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === "string") return new Response(result, { status: 200 });
  return Response.json(result as Record<string, unknown>);
}

function matches(key: string, call: RecordedCall): boolean {
  if (key === "*") return true;
  const [method, pattern] = key.split(/\s+/, 2);
  if (!pattern) return false;
  if (method !== "*" && method!.toUpperCase() !== call.method) return false;
  const path = call.path.split("?")[0]!;
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path || pattern === call.path;
}

const WRITE = /^(POST|PUT|PATCH|DELETE)$/;

/**
 * Install a fake transport for the rest of the test. Call `restore()` in an
 * `afterEach`/`afterAll` (or use `using`) so the next file starts clean.
 */
export function fakeProviders(routes: Routes = {}): FakeProviders {
  const calls: RecordedCall[] = [];
  let table: Routes = { ...routes };
  let live = true;

  const transport: Transport = async (raw: ProviderCall) => {
    const query = raw.path.includes("?") ? raw.path.slice(raw.path.indexOf("?") + 1) : "";
    let json: any = null;
    if (raw.body) {
      try {
        json = JSON.parse(raw.body);
      } catch {
        /* form-encoded or plain text — `body` still has it verbatim */
      }
    }
    const call: RecordedCall = { ...raw, json, params: new URLSearchParams(query), line: `${raw.method} ${raw.path}` };
    calls.push(call);

    for (const key of Object.keys(table)) {
      if (!matches(key, call)) continue;
      const route = table[key]!;
      return toResponse(typeof route === "function" ? await (route as RouteFn)(call) : route);
    }
    // Unrouted writes are the point: the call is recorded and answered the way
    // a player endpoint answers, so the verb succeeds and the account is
    // untouched. An unrouted READ is a missing fixture, and says so loudly
    // rather than handing back an empty body the caller has to guess about.
    if (WRITE.test(call.method)) return new Response(null, { status: 204 });
    throw new Error(
      `fake providers: no fixture for ${call.provider} ${call.line} — add a route to fakeProviders({ "${call.line.split("?")[0]}": … }).`,
    );
  };

  const previous = setTransport(transport);

  return {
    calls,
    lines: () => calls.map((c) => c.line),
    writes: () => calls.filter((c) => WRITE.test(c.method)),
    from: (provider: string) => calls.filter((c) => c.provider === provider),
    last: () => calls[calls.length - 1],
    route(more: Routes) {
      table = { ...table, ...more };
    },
    reset() {
      calls.length = 0;
    },
    restore() {
      if (!live) return;
      live = false;
      setTransport(previous);
    },
    [Symbol.dispose]() {
      this.restore();
    },
  };
}
