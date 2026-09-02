import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startDaemon } from "../server/daemon.ts";
import { readStream, subscribe } from "../host/index.ts";

/**
 * Regression for #92: "reconnecting… (n)" climbing over a HEALTHY connection.
 *
 * The reported symptom was a window that had been sitting in the background for
 * a few minutes and appeared to lose SSE for good — a large, frozen attempt
 * count in the footer, while `lsof` showed an ESTABLISHED socket to the daemon
 * and the daemon itself was fine. Nobody could reproduce it, because the *cause*
 * was never the network.
 *
 * readStream ran the host's render inline in its read loop. A render that threw
 * — once, for any reason — unwound readStream; subscribe() caught that as a
 * dropped socket, incremented the attempt counter, wrote the footer note and
 * reconnected; the fresh connection was greeted with the SAME snapshot, which
 * threw the same way. That is a permanent, self-sustaining fake outage, and the
 * counter it prints is a lifetime tally (it only ever reset on a clean stream
 * end, which a daemon that never closes its stream does not hand out), which is
 * why the number in the report was 77.
 *
 * The three tests below are the three halves of the fix: a consumer that throws
 * cannot end the stream, a stream that delivers is announced as live, and the
 * failure count is consecutive rather than cumulative.
 */
const noop = () => {};

let daemon: Server | null = null;
let stop: AbortController | null = null;

afterEach(() => {
  stop?.abort();
  stop = null;
  daemon?.stop(true);
  daemon = null;
  delete process.env.KONA_PORT;
  delete process.env.KONA_CONNECT_MS;
  delete process.env.KONA_STALL_MS;
});

async function liveDaemon() {
  process.env.KONA_NO_WATCH = "1";
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-reconnect-"));
  daemon = await startDaemon(0);
  process.env.KONA_PORT = String(daemon.port);
  process.env.KONA_CONNECT_MS = "5000";
  return daemon;
}

/** Poll until `done()` or the budget runs out — the stream is asynchronous. */
async function until(done: () => boolean, ms = 8000) {
  const deadline = performance.now() + ms;
  while (!done() && performance.now() < deadline) await Bun.sleep(25);
  return done();
}

test("a render that throws does not take the stream down with it", async () => {
  await liveDaemon();

  // The consumer is broken on EVERY frame — the worst case, and the one that
  // used to be permanent. The stream must not care.
  let delivered = 0;
  const errors: unknown[] = [];
  let live = 0;
  const streaming = readStream(
    () => {
      delivered++;
      throw new Error("TextBuffer is destroyed");
    },
    () => {
      delivered++;
      throw new Error("TextBuffer is destroyed");
    },
    { onLive: () => live++, onConsumerError: (e) => errors.push(e) },
  );
  streaming.catch(() => {});

  // Snapshot, then live state events (the daemon's applets tick on their own).
  expect(await until(() => delivered >= 3)).toBe(true);
  expect(live).toBe(1); // ONE connection served all of them — no reconnect churn
  expect(errors.length).toBe(delivered); // ...and every throw was reported, not swallowed

  daemon!.stop(true);
  await streaming.catch(() => {});
});

test("subscribe never reports a drop while the socket is fine", async () => {
  await liveDaemon();

  const drops: number[] = [];
  let live = 0;
  stop = new AbortController();
  void subscribe(
    () => {
      throw new Error("view exploded");
    },
    () => {
      throw new Error("view exploded");
    },
    (attempt) => drops.push(attempt),
    () => live++,
    stop.signal,
  );

  expect(await until(() => live >= 1)).toBe(true);
  await Bun.sleep(2000); // long enough for the old code to spiral into ~10 drops

  // The whole bug, in one assertion: the footer had nothing to say, because
  // nothing was ever wrong with the connection.
  expect(drops).toEqual([]);
  expect(live).toBe(1);
});

test("the attempt count is consecutive failures, not a lifetime tally", async () => {
  // A stand-in for the daemon whose /events can be turned off and on while
  // /health stays green — so the loop sees real connect failures and real
  // recoveries, and ensureDaemon() (which probes /health) never spawns anything.
  let mode: "reject" | "serve" = "reject";
  let open: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fake = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true, applets: 0 });
      if (path !== "/events") return new Response("not found", { status: 404 });
      // A socket that answers nothing — the shape a wedged connect really has,
      // and the one the connect watchdog exists for.
      if (mode === "reject") return new Promise<Response>(() => {});
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            open = c;
            c.enqueue(new TextEncoder().encode(`event: snapshot\ndata: {}\n\n`));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  process.env.KONA_PORT = String(fake.port);
  process.env.KONA_CONNECT_MS = "200";

  const drops: number[] = [];
  let live = 0;
  stop = new AbortController();
  void subscribe(noop, noop, (attempt) => drops.push(attempt), () => live++, stop.signal);

  try {
    expect(await until(() => drops.length >= 3)).toBe(true);
    expect(drops.slice(0, 3)).toEqual([1, 2, 3]);
    expect(live).toBe(0); // nothing ever connected, so nothing ever reset it

    // Let it through. One good connection means the run of failures is over.
    mode = "serve";
    expect(await until(() => live >= 1)).toBe(true);

    // ...so the next failure starts counting from one again. Before the fix the
    // count kept climbing from where it left off for the life of the process,
    // which is how a window that had been reconnecting happily for an hour ended
    // up frozen at "(77)" — and why the backoff never came back down and
    // ensureDaemon() ran on every drop from the second one onward.
    const before = drops.length;
    mode = "reject";
    open?.close(); // end the healthy stream; the next connect is the one that fails
    expect(await until(() => drops.length > before)).toBe(true);
    expect(drops[before]).toBe(1);
  } finally {
    stop.abort();
    fake.stop(true);
  }
}, 20_000);
