import { test, expect, afterAll, beforeEach } from "bun:test";
import {
  applyFlags,
  fromName,
  graphMessage,
  graphQuery,
  groupConversations,
  messageBody,
  odataQuote,
  recipients,
  toRecipients,
  toStoredDraft,
  toThread,
  OutlookProvider,
  type GraphMessage,
} from "../server/outlook.ts";

/**
 * Two layers: the pure Graph shaping (no network, no auth), and the write half
 * against a fixture Graph on localhost — where the interesting part is that
 * kona's rows are conversations and Graph's writes are per message.
 */

function msg(over: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: "m1",
    conversationId: "c1",
    subject: "standup notes",
    bodyPreview: "  here they   are\n ",
    receivedDateTime: "2026-08-31T09:15:00Z",
    isRead: true,
    from: { emailAddress: { name: "Grace Hopper", address: "grace@work.com" } },
    ...over,
  };
}

test("fromName prefers the display name and falls back to the address", () => {
  expect(fromName(msg())).toBe("Grace Hopper");
  expect(fromName(msg({ from: { emailAddress: { address: "bare@work.com" } } }))).toBe("bare@work.com");
  expect(fromName(msg({ from: undefined, sender: { emailAddress: { name: "Sent By" } } }))).toBe("Sent By");
  expect(fromName(msg({ from: undefined, sender: undefined }))).toBe("(unknown)");
});

test("toThread keys the row by conversation and normalizes the snippet", () => {
  const t = toThread(msg());
  expect(t.id).toBe("c1"); // the CONVERSATION, so `open` re-fetches the thread
  expect(t.subject).toBe("standup notes");
  expect(t.snippet).toBe("here they are");
  expect(t.unread).toBe(false);
  expect(t.ts).toBe(Date.parse("2026-08-31T09:15:00Z"));
  expect(toThread(msg({ subject: "" })).subject).toBe("(no subject)");
  // A message with no conversation still gets a row, keyed by its own id.
  expect(toThread(msg({ conversationId: undefined })).id).toBe("m1");
});

test("toThread reads Graph's isRead as kona's unread", () => {
  expect(toThread(msg({ isRead: false })).unread).toBe(true);
  expect(toThread(msg({ isRead: true })).unread).toBe(false);
});

test("groupConversations folds messages into newest-first threads", () => {
  const rows = groupConversations([
    msg({ id: "a", conversationId: "c1", receivedDateTime: "2026-08-30T09:00:00Z", subject: "old reply" }),
    msg({ id: "b", conversationId: "c1", receivedDateTime: "2026-08-31T09:00:00Z", subject: "new reply" }),
    msg({ id: "c", conversationId: "c2", receivedDateTime: "2026-08-29T09:00:00Z", subject: "another" }),
  ]);
  expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
  expect(rows[0]!.subject).toBe("new reply"); // newest message wins the row
});

test("a conversation is unread when any message in it is", () => {
  const rows = groupConversations([
    msg({ id: "a", isRead: false, receivedDateTime: "2026-08-30T09:00:00Z" }),
    msg({ id: "b", isRead: true, receivedDateTime: "2026-08-31T09:00:00Z" }),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.unread).toBe(true);
});

test("messageBody renders HTML and cleans plain text", () => {
  const html = messageBody(msg({ body: { contentType: "html", content: "<h1>Hi</h1><p>Order <b>ready</b>.</p>" } }));
  expect(html).toContain("Order ready.");
  expect(html).not.toContain("<");
  expect(messageBody(msg({ body: { contentType: "text", content: "hello\n\n\n\nworld  " } }))).toBe("hello\n\nworld");
  expect(messageBody(msg({ body: undefined }))).toBe("");
});

test("graphQuery: the default inbox query needs neither search nor filter", () => {
  expect(graphQuery("in:inbox")).toEqual({});
  expect(graphQuery("")).toEqual({});
});

test("graphQuery maps flags to $filter", () => {
  expect(graphQuery("is:unread")).toEqual({ unread: true, filter: "isRead eq false" });
  expect(graphQuery("in:inbox has:attachment")).toEqual({ hasAttachment: true, filter: "hasAttachments eq true" });
  expect(graphQuery("is:read")).toEqual({ unread: false, filter: "isRead eq true" });
});

test("graphQuery turns field and free-text terms into $search", () => {
  expect(graphQuery("from:doordash").search).toBe("from:doordash");
  expect(graphQuery('subject:"quarterly review"').search).toBe('subject:"quarterly review"');
  expect(graphQuery("in:inbox invoice").search).toBe("invoice");
});

test("graphQuery keeps flags client-side when it must use $search", () => {
  // Graph refuses $search together with $filter, so the flag comes back as a
  // predicate for the provider to apply itself.
  const q = graphQuery("is:unread from:github");
  expect(q.search).toBe("from:github");
  expect(q.filter).toBeUndefined();
  expect(q.unread).toBe(true);

  const rows = [toThread(msg({ isRead: false })), toThread(msg({ id: "m2", conversationId: "c2", isRead: true }))];
  expect(applyFlags(rows, q).map((r) => r.id)).toEqual(["c1"]);
  // With no $search the filter already ran server-side; nothing is dropped.
  expect(applyFlags(rows, graphQuery("is:unread"))).toHaveLength(2);
});

test("odataQuote escapes the quote that would break a $filter", () => {
  expect(odataQuote("AAQkAD")).toBe("'AAQkAD'");
  expect(odataQuote("o'brien")).toBe("'o''brien'");
});

// --- the write side, against a fixture Graph --------------------------------

interface Call {
  method: string;
  path: string;
  query: string;
  body: any;
}
let calls: Call[] = [];

/** Two messages in one conversation, which is what makes the fan-out visible. */
const CONVERSATION: GraphMessage[] = [
  { id: "m1", conversationId: "c1", subject: "standup", categories: ["blue"] },
  { id: "m2", conversationId: "c1", subject: "standup" },
];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams.get("$filter") ?? "", body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

    if (url.pathname === "/me/messages" && req.method === "GET") return json({ value: CONVERSATION });
    if (url.pathname === "/me/mailFolders/drafts/messages") {
      return json({
        value: [
          {
            id: "d1",
            subject: "quarterly review",
            toRecipients: [{ emailAddress: { name: "Grace", address: "grace@y.com" } }],
            body: { contentType: "Text", content: "half a thought" },
            lastModifiedDateTime: "2026-09-01T00:00:00Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/createReply")) return json({ id: "reply-1" });
    if (url.pathname === "/me/messages" && req.method === "POST") return json({ id: "d-new" });
    return new Response("", { status: 202 }); // send / move / patch answer empty
  },
});

process.env.KONA_GRAPH_API = `http://localhost:${server.port}`;
process.env.KONA_MICROSOFT_TOKEN = "test-token";

beforeEach(() => {
  calls = [];
});

afterAll(() => {
  server.stop(true);
  delete process.env.KONA_GRAPH_API;
  delete process.env.KONA_MICROSOFT_TOKEN;
});

const outlook = () => new OutlookProvider("grace@work.com");

test("recipients round-trip between Graph's shape and kona's strings", () => {
  expect(recipients([{ emailAddress: { name: "Ada Lovelace", address: "ada@x.com" } }])).toEqual([
    "Ada Lovelace <ada@x.com>",
  ]);
  expect(recipients([{ emailAddress: { address: "bare@x.com" } }])).toEqual(["bare@x.com"]);
  expect(recipients(undefined)).toEqual([]);
  expect(toRecipients(["Ada Lovelace <ada@x.com>", "grace@y.com, bob@z.com", "junk"])).toEqual([
    { emailAddress: { address: "ada@x.com" } },
    { emailAddress: { address: "grace@y.com" } },
    { emailAddress: { address: "bob@z.com" } },
  ]);
});

test("graphMessage sends plain text, and omits an empty cc", () => {
  expect(graphMessage({ to: ["ada@x.com"], subject: "hi", body: "yo" })).toEqual({
    subject: "hi",
    body: { contentType: "Text", content: "yo" },
    toRecipients: [{ emailAddress: { address: "ada@x.com" } }],
  });
  expect(graphMessage({ to: [], cc: ["grace@y.com"], subject: "", body: "" }).ccRecipients).toEqual([
    { emailAddress: { address: "grace@y.com" } },
  ]);
});

test("toStoredDraft reopens a Graph draft in the composer's shape", () => {
  expect(
    toStoredDraft({
      id: "d1",
      subject: "later",
      toRecipients: [{ emailAddress: { address: "ada@x.com" } }],
      body: { contentType: "Text", content: "half a thought" },
      lastModifiedDateTime: "2026-09-01T00:00:00Z",
    }),
  ).toEqual({
    id: "d1",
    to: ["ada@x.com"],
    cc: [],
    subject: "later",
    body: "half a thought",
    ts: Date.parse("2026-09-01T00:00:00Z"),
  });
});

test("a new message goes through sendMail", async () => {
  await outlook().send({ to: ["ada@x.com"], subject: "hi", body: "yo" });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /me/sendMail"]);
  expect(calls[0]!.body.message.toRecipients).toEqual([{ emailAddress: { address: "ada@x.com" } }]);
  expect(calls[0]!.body.saveToSentItems).toBe(true);
});

test("a reply is created on the message, rewritten, then sent — so it stays in the conversation", async () => {
  await outlook().send({
    to: ["ada@x.com"],
    cc: ["grace@y.com"],
    subject: "Re: standup",
    body: "on it",
    inReplyTo: { id: "m2" },
  });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /me/messages/m2/createReply",
    "PATCH /me/messages/reply-1",
    "POST /me/messages/reply-1/send",
  ]);
  expect(calls[1]!.body).toMatchObject({
    subject: "Re: standup",
    body: { contentType: "Text", content: "on it" },
  });
});

test("drafts are created, updated in place, listed and sent", async () => {
  expect(await outlook().saveDraft({ to: ["ada@x.com"], subject: "later", body: "" })).toEqual({ id: "d-new" });
  expect(calls[0]).toMatchObject({ method: "POST", path: "/me/messages" });
  expect(calls[0]!.body.isDraft).toBe(true);

  calls = [];
  expect(await outlook().saveDraft({ to: [], subject: "later", body: "", draftId: "d1" })).toEqual({ id: "d1" });
  expect(calls[0]).toMatchObject({ method: "PATCH", path: "/me/messages/d1" });

  calls = [];
  await outlook().sendDraft("d1");
  expect(calls[0]).toMatchObject({ method: "POST", path: "/me/messages/d1/send" });

  const drafts = await outlook().listDrafts(20);
  expect(drafts.map((d) => [d.subject, d.to])).toEqual([["quarterly review", ["Grace <grace@y.com>"]]]);
});

test("read, archive and trash fan out over every message in the conversation", async () => {
  await outlook().markRead("c1", true);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /me/messages", // which messages are in c1?
    "PATCH /me/messages/m1",
    "PATCH /me/messages/m2",
  ]);
  expect(calls[0]!.query).toBe("conversationId eq 'c1'");
  expect(calls[1]!.body).toEqual({ isRead: true });

  calls = [];
  await outlook().archive("c1");
  expect(calls.slice(1).map((c) => c.body)).toEqual([{ destinationId: "archive" }, { destinationId: "archive" }]);

  calls = [];
  await outlook().trash("c1");
  expect(calls.slice(1).map((c) => c.body)).toEqual([
    { destinationId: "deleteditems" },
    { destinationId: "deleteditems" },
  ]);
});

test("a label is a category, appended to what the message already has", async () => {
  await outlook().label("c1", "todo");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /me/messages",
    "PATCH /me/messages/m1",
    "PATCH /me/messages/m2",
  ]);
  expect(calls[1]!.body).toEqual({ categories: ["blue", "todo"] });
  expect(calls[2]!.body).toEqual({ categories: ["todo"] });
});
