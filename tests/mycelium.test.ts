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
} from "../server/mycelium.ts";

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
