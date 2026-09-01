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
  process.env.KONA_SCHEDULER_MS = "50"; // the cron pass, fast enough to watch
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
  const tools = (await get("/tools")) as Array<{ name: string; doc?: string; args?: unknown }>;
  expect(tools.map((t) => t.name)).toContain("timer.start");
  // ...and enough about it that an agent needs no second lookup: what the verb
  // does, and args it can send as-is.
  const start = tools.find((t) => t.name === "timer.start")!;
  expect(start.doc).toContain("countdown");
  expect(start.args).toMatchObject({ seconds: 300 });
});

test("the daemon renders the agent skill from the applets it loaded", async () => {
  const res = await fetch(`${url}/skill`);
  expect(res.headers.get("content-type")).toContain("text/markdown");
  const md = await res.text();
  expect(md.startsWith("---\nname: kona\n")).toBe(true);
  expect(md).toContain("### timer — Timer");
  expect(md).toContain(`kona call timer start '{"seconds":300,"label":"tea"}'`);
  // The seam it documents is the one it is being served from.
  expect(md).toContain(`${url}/tools`);
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

test("the dash picks up another applet's card without knowing about it", async () => {
  // The seam under test is ctx.applets(): dash asks every LOADED applet what it
  // has to say and draws the answers, so a countdown started over HTTP puts a
  // row on the cockpit with nothing in applets/dash naming the timer.
  const started = await call("timer", "start", { seconds: 300, label: "e2e" });
  await call("dash", "refresh", {});
  const dash = await get("/applets/dash/state");
  const card = (dash.cards as Array<{ applet: string; text: string; navigate: string }>).find(
    (c) => c.applet === "timer",
  );
  expect(card?.text).toContain("e2e");
  expect(card?.navigate).toBe("timer");

  // ...and it stops saying so the moment the countdowns are gone (including
  // the paused one an earlier test left on the clock — paused still counts).
  expect(started.ok).toBe(true);
  await call("timer", "stop", { all: true });
  await call("dash", "refresh", {});
  const quiet = await get("/applets/dash/state");
  expect((quiet.cards as Array<{ applet: string }>).some((c) => c.applet === "timer")).toBe(false);
});

test("unknown applet and verb 404 cleanly", async () => {
  const a = await fetch(`${url}/applets/nope/state`);
  expect(a.status).toBe(404);
  const v = await call("timer", "nope", {});
  expect(v.error).toBeDefined();
});

test("a workflow runs other applets' verbs through the daemon's own seam", async () => {
  // The point of ctx.call: an applet composing applets is just another caller,
  // so a workflow's step is indistinguishable from an agent's POST.
  const defined = await call("workflows", "define", {
    name: "test-focus",
    steps: [`timer.start {"seconds":90,"label":"from a workflow"}`, `notes.add {"text":"focus at {{steps.0.id}}"}`],
  });
  expect(defined.result).toMatchObject({ id: "test-focus", steps: 2 });

  const run = await call("workflows", "run", { name: "test-focus" });
  expect(run.result.ok).toBe(true);

  // ...and the OTHER applets really moved.
  const timers = (await get("/applets/timer/state")) as { timers: Array<{ label: string; remaining: number }> };
  expect(timers.timers.some((t) => t.label === "from a workflow" && t.remaining === 90)).toBe(true);
  // A one-line `text` blob titles the note it writes, so a workflow step reads
  // back exactly as it was written.
  const notes = (await get("/applets/notes/state")) as { notes: Array<{ title: string }> };
  // The second step's text carried the first step's result into it.
  const stamped = notes.notes.find((n) => n.title.startsWith("focus at "));
  expect(stamped?.title).not.toBe("focus at "); // an id, not an empty reference
});

test("the daemon fires a scheduled workflow with nobody watching", async () => {
  await call("workflows", "define", {
    name: "test-tick",
    cron: "@every 1s",
    steps: [`notes.add {"text":"scheduled run"}`],
  });

  // No client involved from here: the daemon's scheduler is the only caller.
  const deadline = Date.now() + 5_000;
  let ran = 0;
  while (Date.now() < deadline) {
    const state = (await get("/applets/workflows/state")) as { runs: Array<{ name: string; trigger: string }> };
    ran = state.runs.filter((r) => r.name === "test-tick" && r.trigger === "cron").length;
    if (ran > 0) break;
    await Bun.sleep(100);
  }
  expect(ran).toBeGreaterThan(0);

  const notes = (await get("/applets/notes/state")) as { notes: Array<{ title: string }> };
  expect(notes.notes.some((n) => n.title === "scheduled run")).toBe(true);

  // Take it off the clock so it can't keep firing through the rest of the suite.
  await call("workflows", "schedule", { name: "test-tick", cron: null });
});
