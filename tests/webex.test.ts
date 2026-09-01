import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppletCtx, ViewNode } from "../sdk/index.ts";

/**
 * Three layers, none of them touching a real Webex org:
 *
 *   - the pure parsers (Webex spells a message four ways: text, html, markdown,
 *     files-only) and the read-receipt arithmetic that stands in for the unread
 *     count Webex doesn't give us;
 *   - the REST layer, driven against a local fixture server via KONA_WEBEX_API;
 *   - the applet's verbs, driven exactly as the daemon drives them — including
 *     the two callers of `post` (the compose field's `{value}` and an agent's
 *     `{text, space}`), which must be indistinguishable.
 */

import {
  toMs,
  ago,
  nameFromEmail,
  stripHtml,
  oneLine,
  normalizeSpace,
  normalizeMessage,
  listSpaces,
  listMessages,
  postMessage,
  me,
  readSeen,
  writeSeen,
  markSeen,
  isUnread,
  unreadCount,
  resetAuth,
  type Space,
} from "../server/webex.ts";
import webex from "../applets/webex/index.ts";
import { snapshot } from "../bin/snapshot.ts";

// --- fixture Webex ----------------------------------------------------------

const ROOMS = [
  { id: "r-ship", title: "ship-kona", type: "group", lastActivity: "2026-09-01T12:00:00Z", created: "2026-08-01T00:00:00Z" },
  { id: "r-ada", title: "Ada Lovelace", type: "direct", lastActivity: "2026-09-01T09:00:00Z", created: "2026-08-01T00:00:00Z" },
  { id: "r-quiet", title: "quiet-room", type: "group", lastActivity: "2026-08-20T00:00:00Z", created: "2026-08-01T00:00:00Z" },
];

// Newest first, the way Webex returns them.
const MESSAGES: Record<string, Array<Record<string, unknown>>> = {
  "r-ship": [
    { id: "m2", roomId: "r-ship", personId: "p-ada", personEmail: "ada@x.com", text: "shipping now", created: "2026-09-01T12:00:00Z" },
    { id: "m1", roomId: "r-ship", personId: "p-bob", personEmail: "bob@x.com", html: "<p>morning<br>all</p>", created: "2026-09-01T11:00:00Z" },
  ],
  "r-ada": [{ id: "m3", roomId: "r-ada", personId: "p-ada", personEmail: "ada@x.com", text: "lunch?", created: "2026-09-01T09:00:00Z" }],
  "r-quiet": [],
};

let posted: Array<{ roomId: string; text: string }> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const auth = req.headers.get("authorization");
    if (auth !== "Bearer test-token") return new Response("bad token", { status: 401 });

    if (u.pathname === "/v1/people/me") {
      return Response.json({ id: "p-me", displayName: "Grace Hopper", emails: ["grace@x.com"] });
    }
    if (u.pathname === "/v1/people") {
      const ids = (u.searchParams.get("id") ?? "").split(",");
      const all: Record<string, string> = { "p-ada": "Ada Lovelace", "p-bob": "Bob Barker", "p-me": "Grace Hopper" };
      return Response.json({ items: ids.filter((id) => all[id]).map((id) => ({ id, displayName: all[id] })) });
    }
    if (u.pathname === "/v1/rooms") {
      return Response.json({ items: ROOMS.slice(0, Number(u.searchParams.get("max") ?? 25)) });
    }
    if (u.pathname === "/v1/messages" && req.method === "GET") {
      const roomId = u.searchParams.get("roomId") ?? "";
      if (roomId === "r-denied") return new Response("token expired", { status: 401 });
      if (roomId === "r-busy") return new Response("slow down", { status: 429, headers: { "retry-after": "12" } });
      if (!(roomId in MESSAGES)) return new Response("room not found", { status: 404 });
      return Response.json({ items: MESSAGES[roomId] });
    }
    if (u.pathname === "/v1/messages" && req.method === "POST") {
      const body = (await req.json()) as { roomId: string; text: string };
      posted.push(body);
      const msg = {
        id: `m-${posted.length + 100}`,
        roomId: body.roomId,
        personId: "p-me",
        personEmail: "grace@x.com",
        text: body.text,
        created: new Date().toISOString(),
      };
      MESSAGES[body.roomId]?.unshift(msg);
      return Response.json(msg);
    }
    return new Response("not found", { status: 404 });
  },
});

process.env.KONA_WEBEX_API = `http://localhost:${server.port}`;
process.env.KONA_WEBEX_TOKEN = "test-token";
process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-webex-"));
resetAuth();

afterAll(() => {
  server.stop(true);
  // Leave the process as we found it: another test file booting a real konad
  // must not inherit a fixture URL (or a token) pointing at a stopped server.
  delete process.env.KONA_WEBEX_API;
  delete process.env.KONA_WEBEX_TOKEN;
  resetAuth();
});

beforeEach(() => {
  posted = [];
  writeSeen({}); // every test starts with nothing marked read
});

// --- parsers ----------------------------------------------------------------

test("toMs takes ISO strings, passes numbers, and shrugs at junk", () => {
  expect(toMs("2026-09-01T12:00:00Z")).toBe(Date.parse("2026-09-01T12:00:00Z"));
  expect(toMs(1_756_700_000_000)).toBe(1_756_700_000_000);
  expect(toMs(undefined)).toBe(0);
  expect(toMs("whenever")).toBe(0);
});

test("ago is compact and empty for unknown times", () => {
  expect(ago(0)).toBe("");
  expect(ago(Date.now() - 30_000)).toBe("30s");
  expect(ago(Date.now() - 5 * 60_000)).toBe("5m");
  expect(ago(Date.now() - 3 * 3_600_000)).toBe("3h");
  expect(ago(Date.now() - 2 * 86_400_000)).toBe("2d");
});

test("nameFromEmail falls back to the local part", () => {
  expect(nameFromEmail("ada@x.com")).toBe("ada");
  expect(nameFromEmail("")).toBe("someone");
});

test("stripHtml and oneLine flatten a message into a row", () => {
  expect(stripHtml("<p>morning<br>all</p>")).toBe("morning\nall");
  expect(stripHtml("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  expect(oneLine("  two   lines\nin one  ")).toBe("two lines in one");
});

test("normalizeSpace keeps the shape the view needs", () => {
  const s = normalizeSpace(ROOMS[0]);
  expect(s).toEqual({
    id: "r-ship",
    title: "ship-kona",
    kind: "group",
    lastActivity: Date.parse("2026-09-01T12:00:00Z"),
  });
  expect(normalizeSpace(ROOMS[1])?.kind).toBe("direct");
  // No lastActivity? Fall back to created, so the row still sorts and dates.
  expect(normalizeSpace({ id: "x", title: "x", created: "2026-08-01T00:00:00Z" })?.lastActivity).toBe(
    Date.parse("2026-08-01T00:00:00Z"),
  );
  expect(normalizeSpace({ title: "no id" })).toBeNull();
  expect(normalizeSpace({ id: "y", title: "  " })?.title).toBe("(untitled space)");
});

test("normalizeMessage reads text, html, markdown, or attachments alone", () => {
  const names = new Map([["p-ada", "Ada Lovelace"]]);
  expect(normalizeMessage(MESSAGES["r-ship"]![0], names)).toMatchObject({
    id: "m2",
    from: "Ada Lovelace",
    text: "shipping now",
  });
  expect(normalizeMessage(MESSAGES["r-ship"]![1])).toMatchObject({ from: "bob", text: "morning all" });
  expect(normalizeMessage({ id: "m", personEmail: "z@x.com", markdown: "**bold**" })?.text).toBe("**bold**");
  expect(normalizeMessage({ id: "m", personEmail: "z@x.com", files: ["a", "b"] })?.text).toBe("(2 attachments)");
  expect(normalizeMessage({ personEmail: "z@x.com" })).toBeNull();
});

// --- read receipts (kona's stand-in for an unread count) ---------------------

test("a space is unread until its activity is marked seen", () => {
  const space: Space = { id: "r-ship", title: "ship-kona", kind: "group", lastActivity: 2_000 };
  expect(isUnread(space, {})).toBe(true);
  expect(isUnread(space, { "r-ship": 1_000 })).toBe(true); // read, then someone spoke
  expect(isUnread(space, { "r-ship": 2_000 })).toBe(false);
  // A space that has never had a message is not "waiting for you".
  expect(isUnread({ ...space, lastActivity: 0 }, {})).toBe(false);
});

test("read receipts round-trip through disk and only ever move forward", () => {
  markSeen("r-ship", 5_000);
  expect(readSeen()).toEqual({ "r-ship": 5_000 });
  markSeen("r-ship", 3_000); // an older mark can't un-read a space
  expect(readSeen()["r-ship"]).toBe(5_000);
  markSeen("r-ship", 9_000);
  expect(readSeen()["r-ship"]).toBe(9_000);
});

test("unreadCount counts the spaces with something new", () => {
  const spaces: Space[] = [
    { id: "a", title: "a", kind: "group", lastActivity: 10 },
    { id: "b", title: "b", kind: "group", lastActivity: 10 },
  ];
  expect(unreadCount(spaces, {})).toBe(2);
  expect(unreadCount(spaces, { a: 10 })).toBe(1);
  expect(unreadCount(spaces, { a: 10, b: 10 })).toBe(0);
});

// --- REST layer -------------------------------------------------------------

test("listSpaces returns normalized spaces, most recent first", async () => {
  const spaces = await listSpaces();
  expect(spaces.map((s) => s.id)).toEqual(["r-ship", "r-ada", "r-quiet"]);
  expect(spaces[0]!.title).toBe("ship-kona");
  expect(spaces[1]!.kind).toBe("direct");
});

test("listMessages flips to oldest-first and resolves display names", async () => {
  const messages = await listMessages("r-ship");
  expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]); // reading order
  expect(messages.map((m) => m.from)).toEqual(["Bob Barker", "Ada Lovelace"]);
  expect(messages[0]!.text).toBe("morning all"); // html flattened
});

test("postMessage writes to the space and comes back normalized", async () => {
  const sent = await postMessage("r-ada", "  on my way  ");
  expect(posted).toEqual([{ roomId: "r-ada", text: "on my way" }]);
  expect(sent?.text).toBe("on my way");
  await expect(postMessage("r-ada", "   ")).rejects.toThrow(/empty/);
});

test("who am I", async () => {
  expect((await me()).displayName).toBe("Grace Hopper");
});

test("401 and 429 become advice, not status codes", async () => {
  await expect(listMessages("r-denied")).rejects.toThrow(/kona login webex/);
  await expect(listMessages("r-busy")).rejects.toThrow(/rate-limited — retry in 12s/);
});

// --- the applet -------------------------------------------------------------

type WebexState = typeof webex.initialState;

function harness() {
  const state: WebexState = structuredClone(webex.initialState);
  let emits = 0;
  const ctx: AppletCtx<WebexState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => webex.verbs[verb]!(args, ctx),
  };
}

test("refresh loads spaces, counts unread, and marks itself authed", async () => {
  const h = harness();
  const res = (await h.call("refresh")) as { spaces: number; unread: number; authed: boolean };
  expect(res).toMatchObject({ spaces: 3, authed: true });
  expect(res.unread).toBe(3); // nothing marked read yet
  expect(h.state.me).toBe("Grace Hopper");
  expect(h.emits()).toBeGreaterThan(0);
});

test("open drills in by cursor, by index, or by name — and marks the space read", async () => {
  const h = harness();
  await h.call("refresh");

  const byCursor = (await h.call("open")) as { space: string; messages: number };
  expect(byCursor).toEqual({ space: "ship-kona", id: "r-ship", messages: 2 } as never);
  expect(h.state.open?.messages.map((m) => m.from)).toEqual(["Bob Barker", "Ada Lovelace"]);
  expect(h.state.unread).toBe(2); // ship-kona is read now

  await h.call("back");
  expect(h.state.open).toBeNull();

  // An agent names the space instead of counting rows; a substring is enough.
  const byName = (await h.call("open", { space: "ada" })) as { id: string };
  expect(byName.id).toBe("r-ada");
  expect(h.state.cursor).toBe(1);
  expect(h.state.unread).toBe(1);

  await h.call("back");
  expect((await h.call("open", { index: 2 })) as { id: string }).toMatchObject({ id: "r-quiet" });
  expect(h.state.unread).toBe(0);

  // A named space that doesn't exist is an error — never a silent fall back to
  // whatever the cursor was on.
  expect(await h.call("open", { space: "nowhere" })).toEqual({ error: "no such space: nowhere" } as never);
  expect(h.state.open?.space.id).toBe("r-quiet"); // unchanged
});

test("post is one verb: the compose field's {value} and an agent's {text, space}", async () => {
  const h = harness();
  await h.call("refresh");

  // The agent: no space open, names one.
  const agent = (await h.call("post", { space: "ship-kona", text: "deploy is green" })) as { posted: boolean };
  expect(agent).toMatchObject({ posted: true, space: "ship-kona" });

  // The human: opens a space, presses c, types, hits enter.
  await h.call("open", { space: "Ada" });
  await h.call("compose");
  expect(h.state.composing).toBe(true);
  const human = (await h.call("post", { id: "compose", value: "on my way" })) as { posted: boolean };
  expect(human).toMatchObject({ posted: true, space: "Ada Lovelace" });
  expect(h.state.composing).toBe(false);
  expect(h.state.sent).toBe("on my way");

  expect(posted).toEqual([
    { roomId: "r-ship", text: "deploy is green" },
    { roomId: "r-ada", text: "on my way" },
  ]);
  // Our own message came back in the reloaded space, and didn't leave it unread.
  expect(h.state.open?.messages.at(-1)?.text).toBe("on my way");
  expect(isUnread(h.state.spaces.find((s) => s.id === "r-ada")!, h.state.seen)).toBe(false);
});

test("post refuses an empty message and a nonexistent space", async () => {
  const h = harness();
  await h.call("refresh");
  expect(await h.call("post", { space: "ship-kona", text: "   " })).toMatchObject({ posted: false });
  expect(await h.call("post", { text: "nobody home" })).toMatchObject({ error: "no space to post to" });
  // A misspelled space must NOT land in the selected one.
  expect(await h.call("post", { space: "shp-kona", text: "typo" })).toMatchObject({ error: "no such space: shp-kona" });
  expect(await h.call("read", { space: "nowhere" })).toMatchObject({ error: "no such space: nowhere" });
  expect(posted).toEqual([]);
});

test("compose needs an open space; cancel drops the draft", async () => {
  const h = harness();
  await h.call("refresh");
  expect(await h.call("compose")).toEqual({ error: "open a space first" } as never);
  await h.call("open");
  await h.call("compose");
  h.state.draft = "half a thought";
  await h.call("cancel");
  expect(h.state.composing).toBe(false);
  expect(h.state.draft).toBe("");
});

test("read marks one space or all of them without opening anything", async () => {
  const h = harness();
  await h.call("refresh");
  expect(h.state.unread).toBe(3);
  await h.call("read", { space: "quiet-room" });
  expect(h.state.unread).toBe(2);
  await h.call("read", { all: true });
  expect(h.state.unread).toBe(0);
  expect(h.state.open).toBeNull();
});

test("search filters the list and up/down stay inside it", async () => {
  const h = harness();
  await h.call("refresh");
  const res = (await h.call("search", { q: "room" })) as { matches: number };
  expect(res.matches).toBe(1);
  await h.call("down");
  await h.call("down");
  expect(h.state.cursor).toBe(0); // one match, nowhere to go
  await h.call("search", { q: "" });
  await h.call("down");
  expect(h.state.cursor).toBe(1);
  await h.call("up");
  await h.call("up");
  expect(h.state.cursor).toBe(0);
});

// --- render -----------------------------------------------------------------

/** The node the host will scroll to — the one flagged `focus`. */
function anchor(nodes: unknown): string {
  let found = "";
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.focus && (n.kind === "text" || n.kind === "input")) found = n.text ?? n.placeholder ?? n.value;
    if (n.children) n.children.forEach(walk);
  };
  walk(nodes);
  return found;
}

function flatten(nodes: unknown): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (typeof n === "string") return void out.push(n);
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.kind === "text" || n.kind === "big") return void out.push(n.text);
    if (n.kind === "input") return void out.push(n.placeholder ?? n.value);
    if (n.children) n.children.forEach(walk);
  };
  walk(nodes);
  return out.join("\n");
}

test("the empty view explains both ways in", () => {
  const body = flatten(webex.view(structuredClone(webex.initialState) as WebexState, { width: 80, height: 24 }) as ViewNode[]);
  expect(body).toContain("Not connected to Webex");
  expect(body).toContain("kona login webex");
});

test("the space list renders unread dots and the room view renders a composer", async () => {
  const h = harness();
  await h.call("refresh");
  const list = flatten(webex.view(h.state, { width: 80, height: 24 }) as ViewNode[]);
  expect(list).toContain("ship-kona");
  expect(list).toContain("3 unread");
  expect(list).toContain("● "); // the unread marker

  await h.call("open");
  await h.call("compose");
  const room = flatten(webex.view(h.state, { width: 80, height: 24 }) as ViewNode[]);
  expect(room).toContain("shipping now");
  expect(room).toContain("message ship-kona…");
});

test("a long conversation is anchored at its newest message", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open");

  // Not composing: the trailing hint carries the scroll focus, so the host
  // keeps the bottom of the backlog in view instead of the top.
  const idle = webex.view(h.state, { width: 80, height: 8 }) as ViewNode[];
  expect(anchor(idle)).toContain("press c to write");

  // Composing: the field itself is the anchor (and owns the keyboard).
  await h.call("compose");
  const writing = webex.view(h.state, { width: 80, height: 8 }) as ViewNode[];
  expect(anchor(writing)).toContain("message ship-kona…");
});

test("the applet renders through the real host stage", async () => {
  const frame = await snapshot("webex");
  expect(frame).toContain("Webex");
  expect(frame).toContain("Not connected");
});
