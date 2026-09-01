import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startDaemon } from "../server/daemon.ts";

/**
 * Regression for: "lost daemon: TypeError the socket was closed unexpectedly".
 *
 * The host holds a long-lived SSE connection to /events. When the open applet
 * is idle (a paused/stopped timer emits nothing), the connection goes silent.
 * Bun's `idleTimeout` then closes it and the host's stream read throws. The fix
 * is a periodic heartbeat that keeps the socket warm without waking the applet.
 *
 * This test compresses the failure window: idleTimeout is forced to 1s and the
 * heartbeat to 250ms, then it stays completely idle for 1.6s (> idleTimeout).
 * Without the heartbeat the read below throws/closes and the test fails —
 * which is exactly the bug. With it, the stream stays open and delivers pings.
 */
let server: Server;
let url: string;

beforeAll(async () => {
  process.env.KONA_NO_WATCH = "1";
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-sse-"));
  process.env.KONA_IDLE_TIMEOUT = "1"; // Bun closes idle sockets after 1s
  process.env.KONA_HEARTBEAT_MS = "250"; // ...unless we keep them warm
  server = await startDaemon(0);
  url = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.KONA_IDLE_TIMEOUT;
  delete process.env.KONA_HEARTBEAT_MS;
});

test("idle SSE stream survives past the server idle timeout", async () => {
  const res = await fetch(`${url}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();

  // First frame is the snapshot greeting.
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(dec.decode(first.value)).toContain("snapshot");

  // Stay completely idle (no verb calls) for longer than idleTimeout.
  const deadlineMs = 1600;
  const startedAt = performance.now();
  let heartbeats = 0;
  try {
    while (performance.now() - startedAt < deadlineMs) {
      const { value, done } = await reader.read();
      // `done` here means the socket closed on us — the bug.
      expect(done).toBe(false);
      if (dec.decode(value).includes(":hb")) heartbeats++;
    }
  } finally {
    await reader.cancel();
  }

  // If we got here without throwing and saw keepalives, the socket stayed warm.
  expect(heartbeats).toBeGreaterThan(0);
});
