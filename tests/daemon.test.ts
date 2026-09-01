import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startDaemon } from "../server/daemon.ts";

/**
 * End-to-end over HTTP: this is the actual seam an agent (and the TUI) use.
 * State goes to a throwaway dir so the test never touches real ~/.local/state.
 */
let server: Server;
let url: string;

beforeAll(async () => {
  process.env.KONA_NO_WATCH = "1"; // don't let the applets-dir watcher exit the test
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-test-"));
  server = await startDaemon(0); // 0 = ephemeral port
  url = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const get = (p: string) => fetch(`${url}${p}`).then((r) => r.json());
const call = (id: string, verb: string, args: unknown) =>
  fetch(`${url}/applets/${id}/verbs/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  }).then((r) => r.json());

test("health reports applet count", async () => {
  const h = await get("/health");
  expect(h.ok).toBe(true);
  expect(h.applets).toBeGreaterThan(0);
});

test("applets and tools manifests include the timer", async () => {
  const applets = (await get("/applets")) as Array<{ id: string }>;
  expect(applets.some((a) => a.id === "timer")).toBe(true);
  const tools = (await get("/tools")) as Array<{ name: string }>;
  expect(tools.map((t) => t.name)).toContain("timer.start");
});

test("a verb call mutates shared state, readable by the next client", async () => {
  const res = await call("timer", "start", { seconds: 5, label: "tea" });
  expect(res.ok).toBe(true);
  expect(res.result).toMatchObject({ label: "tea", remaining: 5, running: true });
  expect(res.state.timers).toHaveLength(1);

  // a *separate* request sees the same state — the whole point of the daemon
  const state = await get("/applets/timer/state");
  expect(state.timers[0]).toMatchObject({ id: res.result.id, remaining: 5, running: true });

  // ...and an agent can name that timer instead of the on-screen selection
  const paused = await call("timer", "pause", { id: res.result.id });
  expect(paused.state.timers[0].running).toBe(false);
});

test("unknown applet and verb 404 cleanly", async () => {
  const a = await fetch(`${url}/applets/nope/state`);
  expect(a.status).toBe(404);
  const v = await call("timer", "nope", {});
  expect(v.error).toBeDefined();
});
