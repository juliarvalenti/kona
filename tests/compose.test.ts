import { test, expect } from "bun:test";
import {
  addressOf,
  attribution,
  buildMime,
  dedupe,
  draftSummary,
  encodeAddress,
  encodeWord,
  forwardDraft,
  forwardSubject,
  mimeRaw,
  parseAddresses,
  quote,
  replyDraft,
  replySubject,
  sameAddress,
} from "../server/compose.ts";
import type { OpenThread } from "../server/mail.ts";

/**
 * Composing, without a mailbox: who a reply goes to, what the quoted body
 * looks like, and the RFC-2822 bytes Gmail is handed. All pure — these are the
 * rules you don't want to discover in someone's sent folder.
 */

test("parseAddresses splits what a human types, and keeps a quoted name whole", () => {
  expect(parseAddresses("ada@x.com, grace@y.com")).toEqual(["ada@x.com", "grace@y.com"]);
  expect(parseAddresses("ada@x.com; grace@y.com")).toEqual(["ada@x.com", "grace@y.com"]);
  expect(parseAddresses('"Lovelace, Ada" <ada@x.com>, grace@y.com')).toEqual([
    '"Lovelace, Ada" <ada@x.com>',
    "grace@y.com",
  ]);
  expect(parseAddresses(["ada@x.com", "grace@y.com, bob@z.com"])).toEqual([
    "ada@x.com",
    "grace@y.com",
    "bob@z.com",
  ]);
  expect(parseAddresses("  ")).toEqual([]);
  expect(parseAddresses(undefined)).toEqual([]);
});

test("addressOf finds the mailbox however the name is spelled", () => {
  expect(addressOf("Ada Lovelace <Ada@X.com>")).toBe("ada@x.com");
  expect(addressOf("bare@x.com")).toBe("bare@x.com");
  expect(sameAddress("Ada <ada@x.com>", "ADA@x.com")).toBe(true);
  expect(sameAddress("ada@x.com", "grace@x.com")).toBe(false);
});

test("dedupe drops repeats, non-addresses, and anyone already on the line", () => {
  expect(dedupe(["Ada <ada@x.com>", "ada@x.com", "grace@y.com"])).toEqual(["Ada <ada@x.com>", "grace@y.com"]);
  expect(dedupe(["ada@x.com", "grace@y.com"], ["ADA@x.com"])).toEqual(["grace@y.com"]);
  expect(dedupe(["undisclosed-recipients"])).toEqual([]);
});

test("headers encode as RFC 2047 only when they have to", () => {
  expect(encodeWord("dinner friday?")).toBe("dinner friday?");
  expect(encodeWord("café")).toBe(`=?UTF-8?B?${Buffer.from("café", "utf8").toString("base64")}?=`);
  expect(encodeAddress("ada@x.com")).toBe("ada@x.com");
  expect(encodeAddress("Ada Lovelace <ada@x.com>")).toBe('"Ada Lovelace" <ada@x.com>');
  expect(encodeAddress("Ada Café <ada@x.com>")).toContain("=?UTF-8?B?");
});

test("buildMime writes the headers a reply needs and a UTF-8 base64 body", () => {
  const mime = buildMime({
    to: ["ada@x.com"],
    cc: ["grace@y.com"],
    subject: "Re: dinner 🍜",
    body: "yes — 7pm?",
    inReplyTo: { messageId: "<abc@mail>", references: "<root@mail>" },
  });
  expect(mime).toContain("To: ada@x.com");
  expect(mime).toContain("Cc: grace@y.com");
  expect(mime).toContain("In-Reply-To: <abc@mail>");
  expect(mime).toContain("References: <root@mail> <abc@mail>");
  expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  expect(mime.split("\r\n\r\n")[0]).toContain("=?UTF-8?B?"); // the emoji subject
  const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, "");
  expect(Buffer.from(body, "base64").toString("utf8")).toBe("yes — 7pm?");
  // …and the exact shape Gmail's `raw` field takes.
  expect(Buffer.from(mimeRaw({ to: ["a@x.com"], subject: "hi", body: "yo" }), "base64url").toString()).toContain(
    "To: a@x.com",
  );
});

test("subjects gain one prefix, however many times you answer", () => {
  expect(replySubject("dinner")).toBe("Re: dinner");
  expect(replySubject("Re: dinner")).toBe("Re: dinner");
  expect(replySubject("RE: dinner")).toBe("RE: dinner");
  expect(forwardSubject("dinner")).toBe("Fwd: dinner");
  expect(forwardSubject("Fwd: dinner")).toBe("Fwd: dinner");
  expect(forwardSubject("Fw: dinner")).toBe("Fw: dinner");
});

test("quote prefixes every line, attribution names the sender", () => {
  expect(quote("one\ntwo")).toBe("> one\n> two");
  expect(quote("one\n\ntwo")).toBe("> one\n>\n> two"); // no trailing space on a blank line
  expect(attribution({ from: "Ada", date: "Mon, 1 Sep 2026 10:00:00 +0000" })).toBe(
    "On Mon, 1 Sep 2026 10:00:00 +0000, Ada wrote:",
  );
  expect(attribution({ from: "Ada", date: "" })).toBe("Ada wrote:");
});

const thread: OpenThread = {
  id: "t1",
  subject: "dinner friday?",
  messages: [
    {
      id: "m0",
      from: "Grace Hopper",
      fromAddress: "grace@y.com",
      to: ["ada@x.com"],
      date: "Mon",
      body: "who's in?",
    },
    {
      id: "m1",
      from: "Ada Lovelace",
      fromAddress: "Ada Lovelace <ada@x.com>",
      to: ["grace@y.com", "me@kona.dev"],
      cc: ["bob@z.com"],
      date: "Tue",
      body: "still on for friday?",
      messageId: "<m1@mail>",
      references: "<m0@mail>",
    },
  ],
};

test("reply answers the last sender, quotes the message, and threads", () => {
  const draft = replyDraft(thread, { me: "me@kona.dev" });
  expect(draft.to).toEqual(["Ada Lovelace <ada@x.com>"]);
  expect(draft.cc).toEqual([]); // a plain reply keeps nobody else
  expect(draft.subject).toBe("Re: dinner friday?");
  expect(draft.body).toContain("On Tue, Ada Lovelace wrote:");
  expect(draft.body).toContain("> still on for friday?");
  expect(draft.replyTo).toBe("t1");
  expect(draft.inReplyTo).toEqual({ id: "m1", messageId: "<m1@mail>", references: "<m0@mail>" });
});

test("reply-all keeps everyone but you and the person on the To line", () => {
  const draft = replyDraft(thread, { all: true, me: "me@kona.dev" });
  expect(draft.to).toEqual(["Ada Lovelace <ada@x.com>"]);
  expect(draft.cc).toEqual(["grace@y.com", "bob@z.com"]); // me@kona.dev dropped
});

test("a Reply-To header wins over the From address", () => {
  const withReplyTo: OpenThread = {
    ...thread,
    messages: [{ ...thread.messages[1]!, replyTo: "list@x.com" }],
  };
  expect(replyDraft(withReplyTo).to).toEqual(["list@x.com"]);
});

test("forward prefills nobody, and quotes the message with its own header", () => {
  const draft = forwardDraft(thread);
  expect(draft.to).toEqual([]);
  expect(draft.subject).toBe("Fwd: dinner friday?");
  expect(draft.body).toContain("---------- Forwarded message ----------");
  expect(draft.body).toContain("From: Ada Lovelace");
  expect(draft.body).toContain("still on for friday?");
  expect(draft.inReplyTo).toEqual({ id: "m1" });
});

test("draftSummary reads as a line in a notice", () => {
  expect(draftSummary({ to: ["ada@x.com"], subject: "dinner" })).toBe("dinner → ada@x.com");
  expect(draftSummary({ to: [], subject: "" })).toBe("(no subject)");
});
