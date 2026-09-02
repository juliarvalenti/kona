import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startDaemon } from "../server/daemon.ts";
import { approvals } from "../server/approvals.ts";
import { trustToken, TRUST_HEADER, CALLER_HEADER } from "../core/trust.ts";
import { resetConfig } from "../core/config.ts";

/**
 * The guard over the real seam: one daemon, one route, two callers.
 *
 * Everything here is the same `POST /applets/<id>/verbs/<verb>` the TUI and an
 * agent both use. The ONLY difference between the two is a header — which is
 * the point of the whole feature, and the reason it belongs in an end-to-end
 * test rather than a unit one.
 */

let server: Server;
let url: string;
let token: string;

beforeAll(async () => {
  process.env.KONA_NO_WATCH = "1";
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-approvals-"));
  // A hermetic policy — never the developer's own config. It is the shipped
  // default plus the issue's own worked example of tightening one verb, which
  // gives the test a HELD verb whose effect is visible in local state.
  const cfg = mkdtempSync(join(tmpdir(), "kona-approvals-cfg-"));
  writeFileSync(join(cfg, "config.toml"), '[security]\nguard = ["notes.clear"]\n');
  process.env.KONA_CONFIG_DIR = cfg;
  delete process.env.KONA_TRUST_AGENTS;
  resetConfig();
  server = await startDaemon(0);
  url = `http://localhost:${server.port}`;
  token = trustToken();
});

afterAll(() => server?.stop(true));

beforeEach(() => approvals.reset());

/** An agent: no token, and it says who it is for the audit trail. */
const asAgent = (id: string, verb: string, args: unknown = {}) =>
  fetch(`${url}/applets/${id}/verbs/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CALLER_HEADER]: "claude" },
    body: JSON.stringify(args),
  });

/** A human: the loopback token the host sends, i.e. "a key was pressed". */
const asHuman = (id: string, verb: string, args: unknown = {}) =>
  fetch(`${url}/applets/${id}/verbs/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TRUST_HEADER]: token },
    body: JSON.stringify(args),
  });

const get = (p: string) => fetch(`${url}${p}`).then((r) => r.json());

test("an agent's guarded verb is parked, not run", async () => {
  const res = await asAgent("mycelium", "post", { room: "ship-kona", text: "picking up #83" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; pending: string; action: Record<string, unknown> };

  expect(body.ok).toBe(false);
  expect(body.pending).toMatch(/^p\d+$/);
  expect(body.action).toMatchObject({
    applet: "mycelium",
    verb: "post",
    priority: "high",
    requestedBy: "claude",
    // The exact args, so the human approves the message rather than the verb.
    args: { room: "ship-kona", text: "picking up #83" },
  });

  // Nothing was sent: the message is still a proposal in the tray.
  expect(approvals.pendingCount).toBe(1);
  expect(approvals.log()).toHaveLength(0);
});

test("a verb this machine's config guards is held for an agent too", async () => {
  // `notes.clear` is `local` — the applet says so, and undo takes it back. This
  // machine disagrees, in one line of config, and that is enough.
  await asHuman("notes", "add", { title: "keep me" });
  const res = await asAgent("notes", "clear", {});
  expect(res.status).toBe(202);
  const body = (await res.json()) as { action: { reason: string } };
  expect(body.action.reason).toContain("[security] guard");

  const state = (await get("/applets/notes/state")) as { notes: unknown[] };
  expect(state.notes).toHaveLength(1); // nothing was cleared
});

test("the same call from the TUI just runs — the keypress is its own confirmation", async () => {
  await asHuman("notes", "add", { title: "keep me" });
  const res = await asHuman("notes", "clear", {});
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(approvals.pendingCount).toBe(0);
  expect(((await get("/applets/notes/state")) as { notes: unknown[] }).notes).toHaveLength(0);
});

test("an ordinary verb still runs for an agent, and lands in the audit log", async () => {
  const res = await asAgent("timer", "start", { seconds: 30, label: "tea" });
  expect(res.status).toBe(200);
  const { pending, log } = (await get("/approvals")) as {
    pending: unknown[];
    log: Array<{ applet: string; verb: string; by: string; outcome: string; allowed?: boolean }>;
  };
  expect(pending).toHaveLength(0);
  expect(log[0]).toMatchObject({ applet: "timer", verb: "start", by: "claude", outcome: "ran", allowed: true });
});

test("approving runs the held verb and the agent can read the result off its id", async () => {
  const straight = (await asAgent("notes", "add", { title: "x" }).then((r) => r.json())) as { ok: boolean };
  expect(straight.ok).toBe(true); // notes.add is local — not everything is a decision

  const held = (await asAgent("notes", "clear", {}).then((r) => r.json())) as { pending: string };
  expect(await get(`/approvals/${held.pending}`)).toMatchObject({ status: "pending" });

  // The human approves from the TUI: an ordinary trusted verb call.
  const done = (await asHuman("approvals", "approve", { id: held.pending }).then((r) => r.json())) as {
    result: { outcome: string };
  };
  expect(done.result.outcome).toBe("ran");

  // ...and the agent, watching its id, sees what came of it.
  expect(await get(`/approvals/${held.pending}`)).toMatchObject({ status: "ran" });
  expect(((await get("/applets/notes/state")) as { notes: unknown[] }).notes).toHaveLength(0);
});

test("denying drops it, and the agent's id says so", async () => {
  await asHuman("notes", "add", { title: "survivor" });
  const held = (await asAgent("notes", "clear", {}).then((r) => r.json())) as { pending: string };
  await asHuman("approvals", "deny", { id: held.pending });

  expect(await get(`/approvals/${held.pending}`)).toMatchObject({ status: "denied" });
  expect(((await get("/applets/notes/state")) as { notes: unknown[] }).notes).toHaveLength(1);
});

test("an agent cannot approve its own proposal", async () => {
  const held = (await asAgent("notes", "clear", {}).then((r) => r.json())) as { pending: string };

  const res = await asAgent("approvals", "approve", { id: held.pending });
  // Refused outright rather than queued: an approval an agent can approve is
  // not an approval.
  expect(res.status).toBe(403);
  expect(approvals.pendingCount).toBe(1);
  expect((await res.json()).error).toContain("human");

  // Nor can it move the human's cursor onto a different row before they press
  // `a` — the tray takes no instruction from the thing it is holding.
  expect((await asAgent("approvals", "down", {})).status).toBe(403);
  // Reading it is fine: watching for your own proposal is the point.
  expect((await fetch(`${url}/applets/approvals/state`)).status).toBe(200);
});

test("the manifest flags what will be held, before an agent fires anything", async () => {
  const tools = (await get("/tools")) as Array<{ name: string; priority: string; guarded?: boolean }>;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(byName["mycelium.post"]).toMatchObject({ priority: "high", guarded: true });
  expect(byName["email.trash"]).toMatchObject({ priority: "critical", guarded: true });
  expect(byName["timer.start"]).toMatchObject({ priority: "low" });
  expect(byName["timer.start"]!.guarded).toBeUndefined();
  // Reversible remote playback runs free: it is medium, not held by default.
  expect(byName["spotify.playPause"]).toMatchObject({ priority: "medium" });
  expect(byName["spotify.playPause"]!.guarded).toBeUndefined();
  // A verb the applet talked down is not guarded on a name alone.
  expect(byName["notes.remove"]).toMatchObject({ priority: "low" });
});

test("a watcher on /events hears the decision without polling", async () => {
  const res = await fetch(`${url}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: string[] = [];

  const held = (await asAgent("notes", "clear", {}).then((r) => r.json())) as { pending: string };
  await asHuman("approvals", "approve", { id: held.pending });

  // Read until the decision shows up (or the stream runs dry).
  for (let i = 0; i < 20; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    seen.push(decoder.decode(value));
    if (seen.join("").includes('"decided"')) break;
  }
  await reader.cancel();

  const stream = seen.join("");
  expect(stream).toContain("event: approval");
  expect(stream).toContain('"parked"');
  expect(stream).toContain('"decided"');
});

test("a workflow an agent runs pauses at its first guarded step and resumes on approve", async () => {
  // Two steps, one harmless and one that leaves the machine.
  await asHuman("workflows", "define", {
    name: "guarded-flow",
    steps: ['timer.start {"seconds":45,"label":"flow"}', "notes.clear"],
  });

  // The agent starts the run and does NOT await it: the run is about to stop.
  const running = asAgent("workflows", "run", { name: "guarded-flow" });

  // The second step shows up in the tray on its own terms — the step's args,
  // not "approve the workflow".
  let held: { id: string } | undefined;
  for (let i = 0; i < 100 && !held; i++) {
    held = approvals.list().find((p) => p.applet === "notes" && p.verb === "clear");
    if (!held) await Bun.sleep(20);
  }
  expect(held).toBeDefined();
  expect(approvals.find(held!.id)).toMatchObject({ applet: "notes", verb: "clear" });

  // The first step already ran; the run is parked in the middle, not failed.
  const timers = (await get("/applets/timer/state")) as { timers: Array<{ label: string }> };
  expect(timers.timers.some((t) => t.label === "flow")).toBe(true);

  await asHuman("approvals", "approve", { id: held!.id });
  const out = (await running.then((r) => r.json())) as { result: { ok: boolean; steps: unknown[] } };
  expect(out.result.ok).toBe(true);
  expect(out.result.steps).toHaveLength(2);
});
