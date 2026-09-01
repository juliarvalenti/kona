import { test, expect, afterAll, beforeEach } from "bun:test";
import { header, displayName, extractBody, findLabel, toMessage, toStoredDraft, GmailProvider } from "../server/gmail.ts";

/**
 * Two layers: the pure payload parsing (no network, no auth), and the write
 * half driven against a fixture Gmail on localhost — so the URLs, the bodies
 * and the RFC-2822 bytes kona actually sends are asserted, not assumed.
 */

test("header lookup is case-insensitive", () => {
  const h = [{ name: "From", value: "a@x.com" }, { name: "Subject", value: "hi" }];
  expect(header(h, "from")).toBe("a@x.com");
  expect(header(h, "SUBJECT")).toBe("hi");
  expect(header(h, "missing")).toBe("");
});

test("displayName prefers the name, falls back to the address", () => {
  expect(displayName("Ada Lovelace <ada@x.com>")).toBe("Ada Lovelace");
  expect(displayName('"Grace Hopper" <grace@x.com>')).toBe("Grace Hopper");
  expect(displayName("bare@x.com")).toBe("bare@x.com");
  expect(displayName("<only@x.com>")).toBe("only@x.com");
});

test("extractBody finds the first text/plain part and base64url-decodes it", () => {
  const data = Buffer.from("hello\nworld", "utf8").toString("base64url");
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from("<b>hi</b>").toString("base64url") } },
      { mimeType: "text/plain", body: { data } },
    ],
  };
  expect(extractBody(payload)).toBe("hello\nworld");
});

test("extractBody returns empty when there is no text part", () => {
  expect(extractBody({ mimeType: "image/png", body: { data: "x" } })).toBe("");
  expect(extractBody(undefined)).toBe("");
});

test("extractBody falls back to HTML->text when there is no plain part", () => {
  const html = "<h1>Hi</h1><p>Your order is <b>ready</b>.</p>";
  const payload = {
    mimeType: "text/html",
    body: { data: Buffer.from(html, "utf8").toString("base64url") },
  };
  const out = extractBody(payload);
  expect(out).toMatch(/hi/i); // heading text present (html-to-text upcases h1)
  expect(out).toContain("Your order is ready.");
  expect(out).not.toContain("<"); // tags stripped
});

// --- the write side, against a fixture Gmail --------------------------------

interface Call {
  method: string;
  path: string;
  body: any;
}
let calls: Call[] = [];

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const DRAFTS = [{ id: "d1" }];
const DRAFT_BODY = {
  id: "d1",
  message: {
    internalDate: "1756684800000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "To", value: "grace@y.com" },
        { name: "Subject", value: "quarterly review" },
      ],
      body: { data: b64("half a thought") },
    },
  },
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    calls.push({ method: req.method, path: url.pathname, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

    if (url.pathname === "/gmail/v1/users/me/labels") {
      if (req.method === "GET") return json({ labels: [{ id: "Label_7", name: "Todo" }, { id: "INBOX", name: "INBOX" }] });
      return json({ id: "Label_new", name: (body as { name: string }).name });
    }
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "GET") return json({ drafts: DRAFTS });
    if (url.pathname === "/gmail/v1/users/me/drafts/d1" && req.method === "GET") return json(DRAFT_BODY);
    if (url.pathname.endsWith("/messages/send")) return json({ id: "m-sent", threadId: "t1" });
    if (url.pathname.endsWith("/drafts")) return json({ id: "d-new" });
    if (url.pathname.endsWith("/drafts/d1")) return json({ id: "d1" });
    if (url.pathname.endsWith("/drafts/send")) return json({ id: "m-sent" });
    if (url.pathname.includes("/threads/")) return new Response("", { status: 204 }); // modify / trash
    return new Response("nope", { status: 404 });
  },
});

process.env.KONA_GMAIL_API = `http://localhost:${server.port}`;
process.env.KONA_GOOGLE_TOKEN = "test-token";

beforeEach(() => {
  calls = [];
});

afterAll(() => {
  server.stop(true);
  delete process.env.KONA_GMAIL_API;
  delete process.env.KONA_GOOGLE_TOKEN;
});

const gmail = () => new GmailProvider("ada@gmail.com");

/** The message kona put on the wire, decoded back to readable MIME. */
function sentMime(): string {
  const call = calls.find((c) => c.path.endsWith("/messages/send"))!;
  return Buffer.from(call.body.raw, "base64url").toString("utf8");
}

test("toMessage lifts the headers a reply needs off a full message", () => {
  const m = toMessage({
    id: "m1",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Ada Lovelace <ada@x.com>" },
        { name: "To", value: "grace@y.com, bob@z.com" },
        { name: "Cc", value: "carol@w.com" },
        { name: "Date", value: "Mon, 1 Sep 2026 10:00:00 +0000" },
        { name: "Message-ID", value: "<m1@mail>" },
      ],
      body: { data: b64("still on for friday?") },
    },
  });
  expect(m).toMatchObject({
    id: "m1",
    from: "Ada Lovelace",
    fromAddress: "Ada Lovelace <ada@x.com>",
    to: ["grace@y.com", "bob@z.com"],
    cc: ["carol@w.com"],
    messageId: "<m1@mail>",
    body: "still on for friday?",
  });
  expect(m.replyTo).toBeUndefined(); // no Reply-To header, so no key at all
});

test("findLabel matches a name whatever its case", () => {
  const labels = [{ id: "Label_7", name: "Todo" }];
  expect(findLabel(labels, "todo")?.id).toBe("Label_7");
  expect(findLabel(labels, "  TODO ")?.id).toBe("Label_7");
  expect(findLabel(labels, "receipts")).toBeNull();
});

test("send posts RFC-2822 bytes, with the threadId when it is a reply", async () => {
  const res = await gmail().send({
    to: ["ada@x.com"],
    cc: ["grace@y.com"],
    subject: "Re: dinner",
    body: "yes — 7pm?",
    replyTo: "t1",
    inReplyTo: { messageId: "<m1@mail>" },
  });
  expect(res).toEqual({ id: "m-sent" });
  const call = calls.find((c) => c.path.endsWith("/messages/send"))!;
  expect(call.method).toBe("POST");
  expect(call.body.threadId).toBe("t1");
  const mime = sentMime();
  expect(mime).toContain("To: ada@x.com");
  expect(mime).toContain("Cc: grace@y.com");
  expect(mime).toContain("In-Reply-To: <m1@mail>");

  calls = [];
  await gmail().send({ to: ["ada@x.com"], subject: "hi", body: "yo" });
  expect(calls[0]!.body.threadId).toBeUndefined(); // a new message threads nowhere
});

test("drafts are created, updated in place, listed and sent", async () => {
  const created = await gmail().saveDraft({ to: ["ada@x.com"], subject: "later", body: "" });
  expect(created).toEqual({ id: "d-new" });
  expect(calls[0]).toMatchObject({ method: "POST", path: "/gmail/v1/users/me/drafts" });

  calls = [];
  const updated = await gmail().saveDraft({ to: ["ada@x.com"], subject: "later", body: "", draftId: "d1" });
  expect(updated).toEqual({ id: "d1" });
  expect(calls[0]).toMatchObject({ method: "PUT", path: "/gmail/v1/users/me/drafts/d1" });

  calls = [];
  await gmail().sendDraft("d1");
  expect(calls[0]).toMatchObject({ method: "POST", path: "/gmail/v1/users/me/drafts/send", body: { id: "d1" } });

  const list = await gmail().listDrafts(20);
  expect(list).toEqual([
    { id: "d1", to: ["grace@y.com"], cc: [], subject: "quarterly review", body: "half a thought", ts: 1756684800000 },
  ]);
});

test("toStoredDraft survives a draft with nothing filled in yet", () => {
  expect(toStoredDraft("d9", undefined)).toEqual({ id: "d9", to: [], cc: [], subject: "", body: "", ts: 0 });
});

test("read, archive, trash and label are all label moves on the thread", async () => {
  const p = gmail();
  await p.markRead("t1", true);
  await p.markRead("t1", false);
  await p.archive("t1");
  await p.trash("t1");
  expect(calls.map((c) => [c.path, c.body])).toEqual([
    ["/gmail/v1/users/me/threads/t1/modify", { removeLabelIds: ["UNREAD"] }],
    ["/gmail/v1/users/me/threads/t1/modify", { addLabelIds: ["UNREAD"] }],
    ["/gmail/v1/users/me/threads/t1/modify", { removeLabelIds: ["INBOX"] }],
    ["/gmail/v1/users/me/threads/t1/trash", null],
  ]);

  calls = [];
  await p.label("t1", "todo"); // exists already, whatever the case
  expect(calls.map((c) => c.path)).toEqual(["/gmail/v1/users/me/labels", "/gmail/v1/users/me/threads/t1/modify"]);
  expect(calls[1]!.body).toEqual({ addLabelIds: ["Label_7"] });

  calls = [];
  await p.label("t1", "receipts"); // new: created on the spot, then applied
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /gmail/v1/users/me/labels",
    "POST /gmail/v1/users/me/labels",
    "POST /gmail/v1/users/me/threads/t1/modify",
  ]);
  expect(calls[2]!.body).toEqual({ addLabelIds: ["Label_new"] });
});
