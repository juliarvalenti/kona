import { test, expect } from "bun:test";
import {
  applyFlags,
  fromName,
  graphQuery,
  groupConversations,
  messageBody,
  odataQuote,
  toThread,
  type GraphMessage,
} from "../server/outlook.ts";

/** Pure Microsoft Graph shaping — no network, no auth. */

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
