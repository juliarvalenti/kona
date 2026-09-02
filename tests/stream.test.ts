import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, TCPSocketListener } from "bun";
import { startDaemon } from "../server/daemon.ts";
import { readStream } from "../host/index.ts";

/**
 * Regression for #87: "reconnecting… (n)" forever.
 *
 * readStream's 45s watchdog only ever covered reader.read() — the fetch() that
 * OPENS the stream was awaited bare. A connect that never answers (Bun handing
 * back a dead keep-alive socket from an attempt we just aborted) therefore hung
 * that await for good, and subscribe()'s retry loop only advances when
 * readStream settles: no next attempt, no onDrop, no render, so the window sat
 * on the last drop's footer note until it was killed.
 *
 * The two tests below are the two halves of that: a connect that never answers
 * must give up and throw, and a connect that does answer must still stream.
 */
const noop = () => {};

let dead: TCPSocketListener | null = null;
let daemon: Server | null = null;

afterEach(() => {
  dead?.stop(true);
  dead = null;
  daemon?.stop(true);
  daemon = null;
  delete process.env.KONA_PORT;
  delete process.env.KONA_CONNECT_MS;
});

test("a connect that never answers gives up instead of hanging the retry loop", async () => {
  // A socket that completes the TCP handshake and then says nothing at all —
  // exactly what a stale keep-alive connection looks like to fetch().
  dead = Bun.listen({ hostname: "localhost", port: 0, socket: { data: noop, open: noop } });
  process.env.KONA_PORT = String(dead.port);
  process.env.KONA_CONNECT_MS = "250"; // the real budget is 10s; compress the window

  const startedAt = performance.now();
  // Unguarded, this await never settles and the assertion below never runs.
  await expect(readStream(noop, noop)).rejects.toThrow("connect timed out");
  expect(performance.now() - startedAt).toBeLessThan(3000);
});

test("a live daemon still streams its greeting snapshot", async () => {
  process.env.KONA_NO_WATCH = "1";
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-stream-"));
  daemon = await startDaemon(0);
  process.env.KONA_PORT = String(daemon.port);
  process.env.KONA_CONNECT_MS = "5000";

  // The stream is infinite, so stopping it means stopping the far end — which
  // is also the honest way to end one. (Throwing from onSnapshot used to do it;
  // that is exactly the behaviour #92 removed, so it no longer would.)
  let seen: Record<string, unknown> | null = null;
  const streaming = readStream((s) => {
    seen = s;
  }, noop);
  while (!seen) await Bun.sleep(10);
  daemon.stop(true);
  await streaming.catch(() => {}); // a torn-down daemon ends it either way
  expect(seen).not.toBeNull();
});
