import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppletCtx } from "../sdk/index.ts";
import { resetConfig } from "../core/config.ts";
import {
  setProviders,
  type InboxPage,
  type MailDraft,
  type MailProvider,
  type OpenThread,
  type StoredDraft,
} from "../server/mail.ts";
import email, { fieldOf } from "../applets/email/index.ts";

/**
 * The email applet, driven exactly as the daemon drives it — one fake provider
 * standing in for a mailbox. What is being tested is the WRITE half: that a
 * keypress and an agent call reach the same verb with the same result, that
 * the list moves optimistically and puts itself back when a provider says no,
 * and that the composer is only ever a way to fill in arguments.
 */

// A config dir of our own: two connected accounts, so routing is observable.
const CONFIG = mkdtempSync(join(tmpdir(), "kona-email-"));
writeFileSync(
  join(CONFIG, "accounts.json"),
  JSON.stringify({
    accounts: [
      { provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" },
      { provider: "outlook", id: "grace@work.com", label: "grace@work.com" },
    ],
  }),
);
process.env.KONA_CONFIG_DIR = CONFIG;
resetConfig();

afterAll(() => {
  setProviders(null);
  delete process.env.KONA_CONFIG_DIR;
  resetConfig();
});

// --- a mailbox that writes to an array --------------------------------------

interface Journal {
  sent: MailDraft[];
  saved: MailDraft[];
  sentDrafts: string[];
  read: Array<{ id: string; read: boolean }>;
  archived: string[];
  trashed: string[];
  labelled: Array<{ id: string; name: string }>;
}

const journal = (): Journal => ({
  sent: [],
  saved: [],
  sentDrafts: [],
  read: [],
  archived: [],
  trashed: [],
  labelled: [],
});

const THREAD: OpenThread = {
  id: "t1",
  subject: "dinner friday?",
  messages: [
    {
      id: "m1",
      from: "Ada Lovelace",
      fromAddress: "Ada Lovelace <ada@x.com>",
      to: ["ada@gmail.com", "bob@z.com"],
      cc: ["carol@w.com"],
      date: "Tue",
      body: "still on for friday?",
      messageId: "<m1@mail>",
    },
  ],
};

const PAGE: InboxPage = {
  threads: [
    { id: "t1", from: "Ada Lovelace", subject: "dinner friday?", snippet: "", date: "", ts: 200, unread: true },
    { id: "t2", from: "GitHub", subject: "PR merged", snippet: "", date: "", ts: 100, unread: false },
  ],
};

let log = journal();
let fail: Error | null = null;

function fake(account: string, drafts: StoredDraft[] = []): MailProvider {
  const boom = () => {
    if (fail) throw fail;
  };
  return {
    id: account.includes("work") ? "outlook" : "gmail",
    account,
    async listInbox() {
      return account === "ada@gmail.com" ? PAGE : { threads: [] };
    },
    async getThread(id) {
      return { ...THREAD, id };
    },
    async send(draft) {
      boom();
      log.sent.push(draft);
      return { id: "sent-1" };
    },
    async saveDraft(draft) {
      boom();
      log.saved.push(draft);
      return { id: draft.draftId ?? "d-new" };
    },
    async sendDraft(id) {
      log.sentDrafts.push(id);
    },
    async listDrafts() {
      return drafts;
    },
    async markRead(id, read) {
      boom();
      log.read.push({ id, read });
    },
    async archive(id) {
      boom();
      log.archived.push(id);
    },
    async trash(id) {
      boom();
      log.trashed.push(id);
    },
    async label(id, name) {
      boom();
      log.labelled.push({ id, name });
    },
  };
}

type EmailState = typeof email.initialState;

function harness(drafts: StoredDraft[] = []) {
  setProviders([fake("ada@gmail.com", drafts), fake("grace@work.com")]);
  const state = structuredClone(email.initialState) as EmailState;
  const ctx: AppletCtx<EmailState> = { state, emit: () => {} };
  return {
    state,
    call: (verb: string, args: Record<string, unknown> = {}) => email.verbs[verb]!(args, ctx),
  };
}

beforeEach(() => {
  log = journal();
  fail = null;
  resetConfig();
});

// --- composing ---------------------------------------------------------------

test("compose with a recipient sends; compose with nothing opens the composer", async () => {
  const h = harness();
  await h.call("refresh");

  const sent = (await h.call("compose", { to: "ada@x.com, bob@z.com", subject: "dinner", body: "friday?" })) as {
    sent: boolean;
  };
  expect(sent.sent).toBe(true);
  expect(log.sent).toHaveLength(1);
  expect(log.sent[0]).toMatchObject({ to: ["ada@x.com", "bob@z.com"], subject: "dinner", body: "friday?" });
  expect(h.state.compose).toBeNull(); // the composer closes behind a send
  expect(h.state.notice).toContain("sent:");

  const dialog = (await h.call("compose")) as { dialog: string };
  expect(dialog.dialog).toBe("compose");
  expect(h.state.compose).toMatchObject({ mode: "new", field: "to", values: { to: "", subject: "" } });
});

test("the composer's fields are state, and enter walks them then sends", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("compose");

  // Typing (the host's `change`), then enter (its `submit`) — field by field.
  await h.call("field", { id: "compose.to", value: "ada@x.com" });
  expect(h.state.compose!.values.to).toBe("ada@x.com");
  await h.call("form", { id: "compose.to", value: "ada@x.com" });
  expect(h.state.compose!.field).toBe("cc");
  await h.call("form", { id: "compose.cc", value: "" });
  await h.call("form", { id: "compose.subject", value: "dinner" });
  expect(h.state.compose!.field).toBe("body");

  // The body is written a line at a time; the field id changes with each one.
  await h.call("form", { id: "compose.body#0", value: "friday?" });
  await h.call("form", { id: "compose.body#1", value: "7pm works" });
  expect(h.state.compose!.values.body).toBe("friday?\n7pm works");
  expect(h.state.compose!.line).toBe(2);

  // …and an empty line means "that's the message".
  await h.call("form", { id: "compose.body#2", value: "" });
  expect(log.sent[0]).toMatchObject({ to: ["ada@x.com"], subject: "dinner", body: "friday?\n7pm works" });
  expect(h.state.compose).toBeNull();
});

test("a send with no recipient asks for one instead of going out", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("compose");
  await h.call("form", { id: "compose.subject", value: "no one" });
  const res = (await h.call("send")) as { sent: boolean };
  expect(res.sent).toBe(false);
  expect(log.sent).toEqual([]);
  expect(h.state.compose!.field).toBe("to");
  expect(h.state.notice).toContain("who to?");
});

test("closing a half-written composer keeps it, and `n` picks it back up", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("compose");
  await h.call("field", { id: "compose.to", value: "ada@x.com" });
  await h.call("dismiss");
  expect(h.state.compose).toBeNull();
  expect(h.state.stash).toMatchObject({ mode: "new", values: { to: "ada@x.com" } });

  const resumed = (await h.call("compose")) as { resumed: boolean };
  expect(resumed.resumed).toBe(true);
  expect(h.state.compose!.values.to).toBe("ada@x.com");
});

test("a stashed reply comes back as a reply, still threaded to its message", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open", { index: 0 });
  await h.call("reply");
  await h.call("dismiss");
  await h.call("compose");
  expect(h.state.compose).toMatchObject({ mode: "reply", replyTo: "t1" });

  await h.call("form", { id: "compose.body#0", value: "on it" });
  await h.call("form", { id: "compose.body#1", value: "" });
  expect(log.sent[0]!.replyTo).toBe("t1");
});

test("tab off a half-typed body line keeps the line", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("compose");
  await h.call("field", { id: "compose.to", value: "ada@x.com" });
  await h.call("form", { id: "compose.to", value: "ada@x.com" });
  h.state.compose!.field = "body";
  await h.call("field", { id: "compose.body#0", value: "half a line" });
  await h.call("next"); // tab, back round to the To field
  expect(h.state.compose!.values.body).toBe("half a line");
  expect(h.state.compose!.pending).toBe("");
});

test("reply prefills the composer for a human and sends outright for an agent", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open", { index: 0 });

  await h.call("reply");
  const c = h.state.compose!;
  expect(c.mode).toBe("reply");
  expect(c.values.to).toBe("Ada Lovelace <ada@x.com>");
  expect(c.values.cc).toBe(""); // a plain reply keeps nobody else
  expect(c.values.subject).toBe("Re: dinner friday?");
  expect(c.values.body).toContain("> still on for friday?");
  expect(c.field).toBe("body");
  expect(log.sent).toEqual([]); // nothing sent yet — it is a form

  await h.call("dismiss");
  await h.call("reply", { body: "on it" });
  expect(log.sent).toHaveLength(1);
  expect(log.sent[0]!.body.startsWith("on it")).toBe(true);
  expect(log.sent[0]!.replyTo).toBe("t1"); // threaded
  expect(log.sent[0]!.inReplyTo).toMatchObject({ messageId: "<m1@mail>" });
});

test("reply-all keeps the rest of the thread, minus the mailbox replying", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open", { index: 0 });
  await h.call("replyAll");
  expect(h.state.compose!.values.cc).toBe("bob@z.com, carol@w.com"); // not ada@gmail.com
});

test("an agent can reply to a thread it never opened, by id", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("reply", { id: "t2", body: "thanks" });
  expect(log.sent).toHaveLength(1);
  expect(log.sent[0]!.replyTo).toBe("t2");
});

test("forward prefills the quoted message and waits for a recipient", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open", { index: 0 });
  await h.call("forward");
  expect(h.state.compose!.values.subject).toBe("Fwd: dinner friday?");
  expect(h.state.compose!.values.body).toContain("Forwarded message");
  expect(h.state.compose!.field).toBe("to");

  await h.call("forward", { to: "grace@y.com" });
  expect(log.sent[0]).toMatchObject({ to: ["grace@y.com"], subject: "Fwd: dinner friday?" });
});

// --- drafts ------------------------------------------------------------------

test("a draft is parked with the provider, listed, reopened and sent as itself", async () => {
  const saved: StoredDraft[] = [
    { id: "d1", to: ["grace@y.com"], cc: [], subject: "quarterly review", body: "half a thought", ts: 5 },
  ];
  const h = harness(saved);
  await h.call("refresh");

  await h.call("draft", { to: "ada@x.com", subject: "later", body: "half-written" });
  expect(log.saved[0]).toMatchObject({ to: ["ada@x.com"], subject: "later" });
  expect(h.state.compose).toBeNull(); // an agent wanted it parked, not a form

  const list = (await h.call("drafts")) as { drafts: number; showing: string };
  expect(list).toEqual({ drafts: 1, showing: "drafts" } as never);
  expect(h.state.showDrafts).toBe(true);

  await h.call("open", { index: 0 }); // enter, in the drafts list
  expect(h.state.compose).toMatchObject({
    mode: "draft",
    draftId: "d1",
    values: { to: "grace@y.com", subject: "quarterly review", body: "half a thought" },
  });

  await h.call("send");
  // A saved draft is updated and sent as that draft, so Drafts doesn't keep a copy.
  expect(log.saved[1]).toMatchObject({ draftId: "d1" });
  expect(log.sentDrafts).toEqual(["d1"]);
  expect(log.sent).toEqual([]);
});

// --- filing ------------------------------------------------------------------

test("archive drops the row at once and puts it back if the provider refuses", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("archive", { index: 1 });
  expect(log.archived).toEqual(["t2"]);
  expect(h.state.threads.map((t) => t.id)).toEqual(["t1"]);
  expect(h.state.notice).toContain("archived:");

  fail = new Error("gmail 500: boom");
  await h.call("archive", { id: "t1" });
  expect(h.state.threads.map((t) => t.id)).toEqual(["t1"]); // back where it was
  expect(h.state.notice).toContain("couldn't archive");
});

test("trash routes to the mailbox the row came from", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("trash", { index: 0 });
  expect(log.trashed).toEqual(["t1"]);
  expect(h.state.threads.map((t) => t.id)).toEqual(["t2"]);
});

test("label asks for a name when it hasn't got one, then applies it", async () => {
  const h = harness();
  await h.call("refresh");
  const dialog = (await h.call("label")) as { dialog: string };
  expect(dialog.dialog).toBe("label");
  expect(h.state.prompt).toMatchObject({ kind: "label", id: "t1" });

  // The prompt's field submits to the same verb an agent calls.
  await h.call("label", { id: "t1", value: "todo" });
  expect(log.labelled).toEqual([{ id: "t1", name: "todo" }]);
  expect(h.state.prompt).toBeNull();
  expect(h.state.notice).toContain("todo");
});

// --- read / unread -----------------------------------------------------------

test("opening a thread clears its unread dot", async () => {
  const h = harness();
  await h.call("refresh");
  expect(h.state.threads[0]!.unread).toBe(true);
  await h.call("open", { index: 0 });
  expect(h.state.threads[0]!.unread).toBe(false);
  expect(log.read).toEqual([{ id: "t1", read: true }]);
});

test("`[applets.email] autoRead = false` leaves the dot alone", async () => {
  writeFileSync(join(CONFIG, "config.toml"), "[applets.email]\nautoRead = false\n");
  resetConfig();
  try {
    const h = harness();
    await h.call("refresh");
    await h.call("open", { index: 0 });
    expect(h.state.threads[0]!.unread).toBe(true);
    expect(log.read).toEqual([]);
  } finally {
    writeFileSync(join(CONFIG, "config.toml"), "");
    resetConfig();
  }
});

test("toggleRead flips the row, optimistically, and reverts on failure", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("markRead", { index: 0 });
  expect(h.state.threads[0]!.unread).toBe(false);
  await h.call("toggleRead", { index: 0 });
  expect(h.state.threads[0]!.unread).toBe(true);
  expect(log.read).toEqual([{ id: "t1", read: true }, { id: "t1", read: false }]);

  fail = new Error("gmail 500: boom");
  await h.call("markRead", { index: 0 });
  expect(h.state.threads[0]!.unread).toBe(true); // put back
});

test("a token without the write scopes names the account to reconnect", async () => {
  const h = harness();
  await h.call("refresh");
  fail = new Error("gmail 403: Request had insufficient authentication scopes");
  const res = (await h.call("archive", { index: 0 })) as { scope?: string };
  expect(res.scope).toBe("gmail");
  expect(h.state.scopeNeeded).toBe("gmail");
  expect(h.state.notice).toContain("kona login gmail");
});

test("back peels one layer at a time: composer, thread, drafts list", async () => {
  const h = harness();
  await h.call("refresh");
  await h.call("open", { index: 0 });
  await h.call("reply");
  await h.call("back");
  expect(h.state.compose).toBeNull();
  expect(h.state.open).not.toBeNull();
  await h.call("back");
  expect(h.state.open).toBeNull();
});

test("fieldOf names the field behind an input id, line counter and all", () => {
  expect(fieldOf("compose.to")).toBe("to");
  expect(fieldOf("compose.body#12")).toBe("body");
  expect(fieldOf("label.name")).toBe("name");
  expect(fieldOf(undefined)).toBe("");
});
