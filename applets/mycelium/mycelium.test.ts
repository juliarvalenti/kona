import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toMs,
  ago,
  pickList,
  flattenText,
  names,
  normalizeRoom,
  normalizeMessage,
  normalizeAgent,
  normalizeMemory,
  normalizeRooms,
  normalizeMessages,
  parseJsonl,
  listRooms,
  roomDetail,
  postMessage,
  createRoom,
  setStatus,
  remember,
  unconfirmed,
  slug,
  WriteUnsupported,
  PENDING_TTL_MS,
} from "../../server/mycelium.ts";

/**
 * Two halves: the tolerant parsers (pure — every backend spells its fields
 * differently), and the file + HTTP backends driven against a throwaway rooms
 * dir and a real local server.
 */

test("toMs accepts ms, seconds, and ISO strings", () => {
  expect(toMs(1_756_700_000_000)).toBe(1_756_700_000_000);
  expect(toMs(1_756_700_000)).toBe(1_756_700_000_000); // seconds get scaled
  expect(toMs("2026-09-01T00:00:00Z")).toBe(Date.parse("2026-09-01T00:00:00Z"));
  expect(toMs(undefined)).toBe(0);
  expect(toMs("not a date")).toBe(0);
});

test("ago is compact and empty for unknown times", () => {
  expect(ago(0)).toBe("");
  expect(ago(Date.now() - 30_000)).toBe("30s");
  expect(ago(Date.now() - 5 * 60_000)).toBe("5m");
  expect(ago(Date.now() - 3 * 3_600_000)).toBe("3h");
  expect(ago(Date.now() - 2 * 86_400_000)).toBe("2d");
});

test("pickList unwraps arrays and common envelopes", () => {
  expect(pickList([{ id: "a" }])).toEqual([{ id: "a" }]);
  expect(pickList({ rooms: [{ id: "a" }] })).toEqual([{ id: "a" }]);
  expect(pickList({ data: [{ id: "b" }] })).toEqual([{ id: "b" }]);
  expect(pickList({ nothing: 1 })).toEqual([]);
});

test("flattenText handles strings, content blocks, and {text}", () => {
  expect(flattenText("hi")).toBe("hi");
  expect(flattenText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a b");
  expect(flattenText({ body: "deep" })).toBe("deep");
  expect(flattenText(42)).toBe("");
});

test("names reads string lists and object lists", () => {
  expect(names(["a", "b"])).toEqual(["a", "b"]);
  expect(names([{ name: "planner" }, { id: "coder" }, {}])).toEqual(["planner", "coder"]);
  expect(names("nope")).toEqual([]);
});

test("normalizeRoom accepts alternate field spellings", () => {
  const a = normalizeRoom({ room_id: "ship", members: ["planner", "coder"], message_count: 9, updated_at: "2026-09-01T00:00:00Z" });
  expect(a).toEqual({
    id: "ship",
    name: "ship",
    topic: "",
    agents: ["planner", "coder"],
    messages: 9,
    lastAt: Date.parse("2026-09-01T00:00:00Z"),
  });
  const b = normalizeRoom({ id: "x", name: "Research", description: "lit review", agents: [{ name: "scout" }] });
  expect(b?.name).toBe("Research");
  expect(b?.topic).toBe("lit review");
  expect(b?.agents).toEqual(["scout"]);
  expect(normalizeRoom({ nope: true })).toBeNull(); // no id => not a room
});

test("normalizeMessage pulls sender, body, and time from any spelling", () => {
  const m = normalizeMessage({ author: "coder", content: [{ text: "on   it" }], created_at: 1_756_700_000 });
  expect(m.from).toBe("coder");
  expect(m.text).toBe("on it"); // whitespace collapsed for one-line rows
  expect(m.at).toBe(1_756_700_000_000);
  expect(normalizeMessage({}, 3)).toMatchObject({ id: "m3", from: "?", text: "" });
});

test("normalizeAgent keeps status, drops nameless entries", () => {
  expect(normalizeAgent({ name: "planner", state: "thinking" })).toEqual({ name: "planner", status: "thinking", lastSeen: 0 });
  expect(normalizeAgent({})).toBeNull();
});

test("normalizeMemory reads record lists and plain key/value maps", () => {
  expect(normalizeMemory([{ key: "repo", value: "kona" }])).toEqual([{ key: "repo", value: "kona", at: 0 }]);
  expect(normalizeMemory({ memory: { branch: "main" } })).toEqual([{ key: "branch", value: "main", at: 0 }]);
  expect(normalizeMemory(null)).toEqual([]);
});

test("rooms sort by recency, messages oldest-first", () => {
  const rooms = normalizeRooms({ rooms: [{ id: "old", ts: 1000 }, { id: "new", ts: 2000 }] });
  expect(rooms.map((r) => r.id)).toEqual(["new", "old"]);
  const msgs = normalizeMessages([{ id: "b", ts: 2000 }, { id: "a", ts: 1000 }]);
  expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
});

test("parseJsonl skips blank and malformed lines", () => {
  expect(parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
});

/** A throwaway ~/.mycelium — one room as a directory, one as a bare .jsonl. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kona-mycelium-"));
  const rooms = join(home, "rooms");
  mkdirSync(join(rooms, "ship-kona"), { recursive: true });
  writeFileSync(
    join(rooms, "ship-kona", "room.json"),
    JSON.stringify({ id: "ship-kona", name: "ship kona", topic: "getting v0 out" }),
  );
  writeFileSync(
    join(rooms, "ship-kona", "messages.jsonl"),
    [
      JSON.stringify({ from: "planner", text: "split the work", ts: 1_756_700_000 }),
      JSON.stringify({ from: "coder", text: "on it", ts: 1_756_700_060 }),
    ].join("\n"),
  );
  writeFileSync(join(rooms, "ship-kona", "memory.json"), JSON.stringify({ repo: "juliarvalenti/kona" }));
  writeFileSync(
    join(rooms, "research.jsonl"),
    JSON.stringify({ from: "scout", text: "found a paper", ts: 1_756_600_000 }),
  );
  return home;
}

test("file backend lists rooms from dirs and bare logs, newest first", async () => {
  const home = fakeHome();
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium"); // force: no CLI
  try {
    const { rooms, source } = await listRooms();
    expect(source).toBe("fs");
    expect(rooms.map((r) => r.id)).toEqual(["ship-kona", "research"]);
    expect(rooms[0]!.name).toBe("ship kona");
    expect(rooms[0]!.topic).toBe("getting v0 out");
    expect(rooms[0]!.agents).toEqual(["planner", "coder"]); // derived from senders
    expect(rooms[0]!.messages).toBe(2);
  } finally {
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
  }
});

test("file backend drills into a room: messages, agents, shared memory", async () => {
  const home = fakeHome();
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  try {
    const d = await roomDetail("ship-kona");
    expect(d.source).toBe("fs");
    expect(d.room.name).toBe("ship kona");
    expect(d.messages.map((m) => m.text)).toEqual(["split the work", "on it"]);
    expect(d.room.agents).toEqual(["planner", "coder"]);
    expect(d.memory).toEqual([{ key: "repo", value: "juliarvalenti/kona", at: 0 }]);
    await expect(roomDetail("nope")).rejects.toThrow(/no such room/);
  } finally {
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
  }
});

test("http backend reads a daemon that speaks the OpenAPI shape", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/rooms") return Response.json({ rooms: [{ id: "swarm", members: ["a", "b"], message_count: 2, ts: 1_756_700_000 }] });
      if (p === "/rooms/swarm") return Response.json({ id: "swarm", name: "swarm", topic: "coordination" });
      if (p === "/rooms/swarm/messages") return Response.json([{ author: "a", content: "ping", ts: 1_756_700_000 }]);
      if (p === "/rooms/swarm/agents") return Response.json([{ name: "a", status: "busy" }]);
      if (p === "/rooms/swarm/memory") return Response.json({ plan: "ship it" });
      return new Response("nope", { status: 404 });
    },
  });
  process.env.KONA_MYCELIUM_URL = `http://127.0.0.1:${server.port}`;
  try {
    const { rooms, source } = await listRooms();
    expect(source).toBe("http");
    expect(rooms[0]).toMatchObject({ id: "swarm", agents: ["a", "b"], messages: 2 });

    const d = await roomDetail("swarm");
    expect(d.room.topic).toBe("coordination");
    expect(d.messages[0]).toMatchObject({ from: "a", text: "ping" });
    expect(d.agents).toEqual([{ name: "a", status: "busy", lastSeen: 0 }]);
    expect(d.memory).toEqual([{ key: "plan", value: "ship it", at: 0 }]);
  } finally {
    delete process.env.KONA_MYCELIUM_URL;
    server.stop(true);
  }
});

test("an unreachable backend fails with a message, not a crash", async () => {
  const home = mkdtempSync(join(tmpdir(), "kona-empty-"));
  // Grab a port, then free it — nothing is listening there now.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const dead = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);

  process.env.KONA_MYCELIUM_HOME = home; // no rooms/ dir
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium"); // no CLI
  process.env.KONA_MYCELIUM_URL = dead;
  try {
    await expect(listRooms()).rejects.toThrow(/http:/);
  } finally {
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
    delete process.env.KONA_MYCELIUM_URL;
  }
});

/**
 * The write half: kona joining the swarm rather than watching it. Same shape as
 * the read tests — the pure helpers, then the file and HTTP backends driven for
 * real against a throwaway rooms dir and a local server.
 */

test("slug turns a room name into an id", () => {
  expect(slug("Ship kona!")).toBe("ship-kona");
  expect(slug("  lit review  ")).toBe("lit-review");
  expect(slug("***")).toBe("room"); // never empty: an id has to be something
});

test("unconfirmed keeps a sent message until the backend echoes it", () => {
  const now = Date.now();
  const mine = { room: "r", from: "kona", text: "on it", at: now };
  const other = { room: "other", from: "kona", text: "hi", at: now };
  const echoed = [{ id: "1", from: "kona", at: now, text: "on it" }];

  // Nothing came back yet: still pending, so the room shows it.
  expect(unconfirmed([mine, other], [], "r", now)).toEqual([mine, other]);
  // The backend now has it: drop the local copy, or the room shows it twice.
  expect(unconfirmed([mine, other], echoed, "r", now)).toEqual([other]);
  // A message for another room isn't reconciled by this room's refresh.
  expect(unconfirmed([other], echoed, "r", now)).toEqual([other]);
  // Too old to keep claiming, echoed or not.
  expect(unconfirmed([mine], [], "r", now + PENDING_TTL_MS + 1)).toEqual([]);
});

test("file backend posts, and the message reads back", async () => {
  const home = fakeHome();
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  try {
    const { source, message } = await postMessage("ship-kona", "kona", "taking #38");
    expect(source).toBe("fs");
    expect(message).toMatchObject({ from: "kona", text: "taking #38" });

    const d = await roomDetail("ship-kona");
    expect(d.messages.map((m) => m.text)).toEqual(["split the work", "on it", "taking #38"]);
    expect(d.room.agents).toContain("kona"); // now a participant, not a spectator

    // A bare .jsonl room is appendable too — it IS the log.
    await postMessage("research", "kona", "reading it");
    expect((await roomDetail("research")).messages.map((m) => m.from)).toEqual(["scout", "kona"]);
  } finally {
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
  }
});

test("file backend creates a room, sets status, and writes shared memory", async () => {
  const home = fakeHome();
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  try {
    const { rooms, writable } = await listRooms();
    expect(writable).toBe(true); // the rooms dir is writable, so kona can post
    expect(rooms.map((r) => r.id)).not.toContain("lit-review");

    const created = await createRoom({ name: "Lit Review", topic: "papers" });
    expect(created.room.id).toBe("lit-review");
    expect((await listRooms()).rooms.map((r) => r.id)).toContain("lit-review");
    await expect(createRoom({ name: "Lit Review" })).rejects.toThrow(/exists/);

    await setStatus("kona", "shipping #38", "ship-kona");
    expect((await roomDetail("ship-kona")).agents).toEqual([
      expect.objectContaining({ name: "kona", status: "shipping #38" }),
    ]);

    await remember("ship-kona", "plan", "composer first");
    const memory = (await roomDetail("ship-kona")).memory;
    // The fixture's existing entry survives; the new one joins it.
    expect(memory).toContainEqual({ key: "repo", value: "juliarvalenti/kona", at: 0 });
    expect(memory).toContainEqual({ key: "plan", value: "composer first", at: 0 });
  } finally {
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
  }
});

test("http backend posts to the room's messages route", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (req.method === "GET" && p === "/rooms") return Response.json({ rooms: [{ id: "swarm" }] });
      if (req.method !== "POST") return new Response("nope", { status: 404 });
      const body = await req.json();
      seen.push({ path: p, body });
      if (p === "/rooms/swarm/messages") return Response.json({ id: "m9", author: "kona", content: "hi", ts: 1_756_700_000 });
      if (p === "/rooms") return Response.json({ id: "new-room", name: "new room" });
      if (p === "/rooms/swarm/memory") return Response.json({ ok: true });
      return new Response("nope", { status: 404 });
    },
  });
  process.env.KONA_MYCELIUM_URL = `http://127.0.0.1:${server.port}`;
  try {
    const { message, source } = await postMessage("swarm", "kona", "hi");
    expect(source).toBe("http");
    expect(message).toMatchObject({ id: "m9", from: "kona", text: "hi" });
    expect(seen[0]).toEqual({ path: "/rooms/swarm/messages", body: { room: "swarm", from: "kona", text: "hi" } });

    expect((await createRoom({ name: "New Room" })).room.id).toBe("new-room");
    expect((await remember("swarm", "plan", "ship it")).memo).toMatchObject({ key: "plan", value: "ship it" });

    // Nothing here is writable: the daemon 404s every route we know.
    await expect(setStatus("kona", "thinking")).rejects.toThrow(WriteUnsupported);
  } finally {
    delete process.env.KONA_MYCELIUM_URL;
    server.stop(true);
  }
});

test("a read-only backend answers WriteUnsupported, not a plain failure", async () => {
  // The difference is the whole read-only story: the applet puts its composer
  // away for WriteUnsupported and keeps it for anything else.
  const home = mkdtempSync(join(tmpdir(), "kona-readonly-"));
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.method === "GET" ? Response.json({ rooms: [{ id: "swarm" }] }) : new Response("read only", { status: 405 }),
  });
  process.env.KONA_MYCELIUM_URL = `http://127.0.0.1:${server.port}`;
  process.env.KONA_MYCELIUM_HOME = home; // no rooms/ dir: no file backend either
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  try {
    expect((await listRooms()).writable).toBeNull(); // unknown until something is tried
    await expect(postMessage("swarm", "kona", "hi")).rejects.toThrow(WriteUnsupported);
  } finally {
    delete process.env.KONA_MYCELIUM_URL;
    delete process.env.KONA_MYCELIUM_HOME;
    delete process.env.KONA_MYCELIUM_BIN;
    server.stop(true);
  }
});

/**
 * The applet itself — the chat loop end to end, driven exactly as the host and
 * an agent drive it: verbs in, state out. Nothing here knows about a terminal.
 */

function ctxOn(state: Record<string, unknown>) {
  return { state, emit: () => {} } as never;
}

/** A fresh applet state over a throwaway ~/.mycelium. */
async function chat() {
  const home = fakeHome();
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  const applet = (await import("./index.ts")).default;
  const state = structuredClone(applet.initialState);
  const ctx = ctxOn(state as unknown as Record<string, unknown>);
  await applet.verbs.refresh!({}, ctx);
  return { applet, state, ctx, home };
}

function clearMycelium() {
  delete process.env.KONA_MYCELIUM_HOME;
  delete process.env.KONA_MYCELIUM_BIN;
  delete process.env.KONA_MYCELIUM_URL;
}

test("the applet posts to the open room and reconciles its own message", async () => {
  const { applet, state, ctx } = await chat();
  try {
    await applet.verbs.open!({ room: "ship-kona" }, ctx);
    expect(state.writable).toBe(true);

    const res = (await applet.verbs.post!({ value: "taking #38" }, ctx)) as { posted: boolean; from: string };
    expect(res.posted).toBe(true);
    expect(res.from).toBe(state.me);
    // The post refreshed the room, so the backend's copy is in and the local
    // one is gone — the message appears exactly once.
    expect(state.open!.messages.filter((m) => m.text === "taking #38")).toHaveLength(1);
    expect(state.pending).toHaveLength(0);
    expect(state.draft).toBe(""); // composer cleared, ready for the next line
  } finally {
    clearMycelium();
  }
});

test("an agent posts to a room nobody has open", async () => {
  const { applet, state, ctx } = await chat();
  try {
    expect(await applet.verbs.post!({ room: "research", text: "found a paper" }, ctx)).toMatchObject({ posted: true });
    expect(state.open).toBeNull(); // no drilling in required
    expect((await roomDetail("research")).messages.map((m) => m.text)).toContain("found a paper");
  } finally {
    clearMycelium();
  }
});

test("a read-only backend puts the composer away and keeps what you typed", async () => {
  const home = mkdtempSync(join(tmpdir(), "kona-ro-applet-"));
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.method === "GET"
        ? Response.json({ rooms: [{ id: "swarm", ts: 1_756_700_000 }] })
        : new Response("read only", { status: 405 }),
  });
  process.env.KONA_MYCELIUM_URL = `http://127.0.0.1:${server.port}`;
  process.env.KONA_MYCELIUM_HOME = home;
  process.env.KONA_MYCELIUM_BIN = join(home, "no-such-mycelium");
  try {
    const applet = (await import("./index.ts")).default;
    const state = structuredClone(applet.initialState);
    const ctx = ctxOn(state as unknown as Record<string, unknown>);
    await applet.verbs.refresh!({}, ctx);
    expect(state.writable).toBeNull(); // optimistic until something is tried

    expect(await applet.verbs.post!({ room: "swarm", value: "hello" }, ctx)).toMatchObject({ error: expect.any(String) });
    expect(state.writable).toBe(false); // the view swaps the composer for a notice
    expect(state.draft).toBe("hello"); // ...without eating the message
    expect(state.pending).toHaveLength(0);
    expect(state.notice).toContain("couldn't post");
  } finally {
    clearMycelium();
    server.stop(true);
  }
});

test("the composer is state: focus, keystrokes and backing out are all verbs", async () => {
  const { applet, state, ctx } = await chat();
  try {
    await applet.verbs.compose!({ room: "ship-kona" }, ctx);
    expect(state.open!.room.id).toBe("ship-kona");
    expect(state.composing).toBe(true);

    applet.verbs.draft!({ id: "composer", value: "half a th" }, ctx);
    expect(state.draft).toBe("half a th");

    // Esc leaves the composer but keeps the draft; esc again leaves the room.
    applet.verbs.back!({}, ctx);
    expect(state.composing).toBe(false);
    expect(state.draft).toBe("half a th");
    applet.verbs.back!({}, ctx);
    expect(state.open).toBeNull();
  } finally {
    clearMycelium();
  }
});

test("a dialog only fills in the arguments — the same verb does the work", async () => {
  const { applet, state, ctx } = await chat();
  try {
    // `create` with nothing to go on opens the form (what the `n` key does).
    expect(await applet.verbs.create!({}, ctx)).toMatchObject({ dialog: "room" });
    applet.verbs.field!({ id: "room.name", value: "Lit Review" }, ctx);
    applet.verbs.field!({ id: "room.topic", value: "papers" }, ctx);
    applet.verbs.next!({}, ctx);
    expect(state.dialog!.field).toBe("name"); // tab wraps around the fields

    expect(await applet.verbs.form!({ id: "room.name", value: "Lit Review" }, ctx)).toMatchObject({
      created: "lit-review",
    });
    expect(state.dialog).toBeNull();
    expect(state.rooms.map((r) => r.id)).toContain("lit-review");
    expect(state.open!.room.id).toBe("lit-review"); // and you land in it, ready to talk
  } finally {
    clearMycelium();
  }
});

test("a memo form takes the key first, then the value, then writes it", async () => {
  const { applet, state, ctx } = await chat();
  try {
    await applet.verbs.open!({ room: "ship-kona" }, ctx);
    expect(await applet.verbs.remember!({}, ctx)).toMatchObject({ dialog: "memo" });
    // Enter on the key with no value yet moves to the value instead of saving
    // half an entry.
    expect(await applet.verbs.form!({ id: "memo.key", value: "plan" }, ctx)).toEqual({ field: "value" });
    expect(await applet.verbs.form!({ id: "memo.value", value: "composer first" }, ctx)).toMatchObject({
      key: "plan",
      value: "composer first",
    });
    expect(state.open!.memory).toContainEqual(expect.objectContaining({ key: "plan", value: "composer first" }));
  } finally {
    clearMycelium();
  }
});

test("status is a verb an agent fires and a form a human fills", async () => {
  const { applet, state, ctx } = await chat();
  try {
    await applet.verbs.open!({ room: "ship-kona" }, ctx);
    expect(await applet.verbs.status!({ status: "shipping #38" }, ctx)).toMatchObject({ status: "shipping #38" });
    expect(state.open!.agents).toContainEqual(expect.objectContaining({ name: state.me, status: "shipping #38" }));

    expect(await applet.verbs.status!({}, ctx)).toMatchObject({ dialog: "status" });
    applet.verbs.dismiss!({}, ctx);
    expect(state.dialog).toBeNull();
  } finally {
    clearMycelium();
  }
});
