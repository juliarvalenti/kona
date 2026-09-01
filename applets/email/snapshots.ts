import { defineSnapshots } from "../../sdk/testing.ts";

/** The unified inbox, the reader, and the two states that need no account. */
/** A morning's mail across two mailboxes — the applet's portrait. */
const DAY = 86_400_000;
const THREADS = [
  ["GitHub", "kona#54 — applet screenshots in the README", "ada@gmail.com", "gmail", 0, true],
  ["Grace Hopper", "standup notes, and the compiler talk", "grace@work.com", "outlook", 0, true],
  ["Ada Lovelace", "dinner friday?", "ada@gmail.com", "gmail", 1, false],
  ["arXiv", "cs.PL digest — 9 new submissions", "ada@gmail.com", "gmail", 1, true],
  ["Recruiting", "re: the terminal thing you shipped", "grace@work.com", "outlook", 2, false],
  ["Alan Turing", "on the imitation game (was: re: demos)", "ada@gmail.com", "gmail", 3, false],
  ["Katherine J.", "trajectory review moved to 14:00", "grace@work.com", "outlook", 4, false],
] as const;

export default defineSnapshots([
  {
    name: "the unified inbox: both mailboxes, newest first, unread led",
    hero: true,
    state: () => ({
      authed: true,
      cursor: 0,
      accounts: [
        { provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" },
        { provider: "outlook", id: "grace@work.com", label: "grace@work.com" },
      ],
      threads: THREADS.map(([from, subject, account, provider, days, unread], i) => ({
        id: `t${i}`,
        account,
        provider,
        from,
        subject,
        snippet: "",
        date: "",
        ts: Date.now() - days * DAY,
        unread,
      })),
    }),
    width: 92,
    height: 20,
    contains: [
      "2 accounts", "7 loaded",
      "●", // unread dot
      "ada", "grace", // per-row account badges
      "dinner friday?", "standup notes, and the compiler talk",
    ],
  },
  {
    name: "inbox list shows senders, subjects, and a cursor",
    state: {
      authed: true,
      cursor: 1,
      accounts: [{ provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" }],
      threads: [
        { id: "1", account: "ada@gmail.com", provider: "gmail", from: "GitHub", subject: "PR merged", snippet: "", date: "", ts: 0, unread: true },
        { id: "2", account: "ada@gmail.com", provider: "gmail", from: "Ada Lovelace", subject: "dinner friday?", snippet: "", date: "", ts: 0, unread: false },
      ],
    },
    width: 80,
    height: 16,
    // (selection is a full-width highlight bar, not a ▸ marker)
    contains: ["GitHub", "Ada Lovelace", "dinner friday?", "●"], // ● = unread dot
  },
  {
    name: "reader shows subject, sender, and body",
    state: {
      authed: true,
      openAccount: "ada@gmail.com",
      open: {
        id: "2",
        subject: "dinner friday?",
        messages: [{ from: "Ada Lovelace", date: "Mon 18:22", body: "still on for friday?" }],
      },
    },
    width: 80,
    height: 18,
    contains: ["dinner friday?", "Ada Lovelace", "still on for friday?"],
  },
  {
    name: "shows a sign-in prompt when unauthenticated",
    width: 72,
    height: 14,
    contains: ["No mail account connected", "kona login"],
  },
  {
    name: "badges each row with its account once two are connected",
    state: {
      authed: true,
      accounts: [
        { provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" },
        { provider: "outlook", id: "grace@work.com", label: "grace@work.com" },
      ],
      threads: [
        { id: "1", account: "ada@gmail.com", provider: "gmail", from: "GitHub", subject: "PR merged", snippet: "", date: "", ts: Date.UTC(2026, 7, 31, 12), unread: true },
        { id: "c1", account: "grace@work.com", provider: "outlook", from: "Grace Hopper", subject: "standup notes", snippet: "", date: "", ts: Date.UTC(2026, 7, 30, 12), unread: false },
      ],
    },
    width: 92,
    height: 16,
    contains: [
      "2 accounts", // the unified header
      "ada", "grace", // per-row account badges
      "PR merged", "standup notes",
    ],
  },
  {
    name: "the composer is a real form over the inbox: fields, quoted body, footer",
    state: {
      authed: true,
      accounts: [{ provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" }],
      compose: {
        mode: "reply",
        field: "body",
        values: {
          to: "Ada Lovelace <ada@x.com>",
          cc: "",
          subject: "Re: dinner friday?",
          body: "yes — 7pm?",
        },
        account: "ada@gmail.com",
        line: 1,
        sending: false,
      },
    },
    width: 80,
    height: 26,
    contains: [
      "reply", // the modal's title, and the breadcrumb
      "Ada Lovelace <ada@x.com>",
      "Re: dinner friday?",
      "yes — 7pm?", // the line already committed
      "empty line sends",
    ],
  },
  {
    name: "asks for a label name in a one-field prompt",
    state: {
      authed: true,
      accounts: [{ provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" }],
      threads: [
        { id: "1", account: "ada@gmail.com", provider: "gmail", from: "GitHub", subject: "PR merged", snippet: "", date: "", ts: 0, unread: true },
      ],
      prompt: { kind: "label", value: "todo", account: "ada@gmail.com", id: "1" },
    },
    width: 72,
    height: 16,
    contains: ["label", "todo"],
  },
  {
    name: "lists saved drafts in place of the inbox",
    state: {
      authed: true,
      accounts: [{ provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" }],
      showDrafts: true,
      drafts: [
        { id: "d1", account: "ada@gmail.com", provider: "gmail", to: ["grace@x.com"], cc: [], subject: "quarterly review", body: "", ts: Date.UTC(2026, 8, 1) },
      ],
    },
    width: 76,
    height: 14,
    contains: ["1 saved", "grace@x.com", "quarterly review"],
  },
]);
