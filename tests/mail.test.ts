import { test, expect, afterEach } from "bun:test";
import {
  archiveThread,
  findAccount,
  isScopeError,
  labelThread,
  listDrafts,
  markRead,
  MailWriteUnsupported,
  saveDraft,
  scopeHint,
  sendMail,
  kcAccountName,
  kcService,
  listInbox,
  mergeThreads,
  setProviders,
  threadKey,
  withLegacy,
  type Account,
  type InboxPage,
  type MailDraft,
  type MailProvider,
  type OpenThread,
  type StoredDraft,
  type UnifiedThread,
} from "../server/mail.ts";

/**
 * The provider seam: accounts, the merge, the fan-out — and the write half,
 * which routes an action to the mailbox that owns the thread and says so
 * plainly when a backend cannot do it. No network anywhere.
 */

afterEach(() => setProviders(null));

function row(over: Partial<UnifiedThread>): UnifiedThread {
  return {
    id: "1",
    from: "Ada",
    subject: "hi",
    snippet: "",
    date: "",
    ts: 0,
    unread: false,
    account: "ada@gmail.com",
    provider: "gmail",
    ...over,
  };
}

/** A provider that answers from a canned list instead of an API. */
function fake(
  account: string,
  provider: "gmail" | "outlook",
  pages: InboxPage[],
  opts: { fail?: string } = {},
): MailProvider {
  let n = 0;
  return {
    id: provider,
    account,
    async listInbox(_q: string, _max: number, token?: string): Promise<InboxPage> {
      if (opts.fail) throw new Error(opts.fail);
      n = token ? Number(token) : 0;
      return pages[n] ?? { threads: [] };
    },
    async getThread(id: string): Promise<OpenThread> {
      return { id, subject: `${account}:${id}`, messages: [] };
    },
  };
}

test("mergeThreads orders newest first across accounts", () => {
  const merged = mergeThreads([
    row({ id: "old", ts: 100, account: "a@x.com" }),
    row({ id: "new", ts: 300, account: "b@y.com", provider: "outlook" }),
    row({ id: "mid", ts: 200, account: "a@x.com" }),
  ]);
  expect(merged.map((t) => t.id)).toEqual(["new", "mid", "old"]);
});

test("mergeThreads breaks ties on account then id, so the order is stable", () => {
  const merged = mergeThreads([
    row({ id: "b", ts: 5, account: "b@y.com" }),
    row({ id: "a", ts: 5, account: "b@y.com" }),
    row({ id: "z", ts: 5, account: "a@x.com" }),
  ]);
  expect(merged.map((t) => `${t.account}/${t.id}`)).toEqual(["a@x.com/z", "b@y.com/a", "b@y.com/b"]);
});

test("threadKey namespaces an id by its account", () => {
  expect(threadKey({ account: "ada@gmail.com", id: "abc" })).toBe("ada@gmail.com abc");
  // Same provider id in two mailboxes is two different rows.
  expect(threadKey({ account: "a@x.com", id: "1" })).not.toBe(threadKey({ account: "b@x.com", id: "1" }));
});

test("keychain naming keeps the pre-accounts Gmail entry readable", () => {
  expect(kcService("gmail")).toBe("kona-gmail");
  expect(kcService("outlook")).toBe("kona-outlook");
  expect(kcAccountName("default")).toBe("refresh-token"); // what older konas wrote
  expect(kcAccountName("ada@gmail.com")).toBe("ada@gmail.com");
});

test("withLegacy adopts an old token only when no Gmail account is registered", () => {
  expect(withLegacy([], true)).toEqual([{ provider: "gmail", id: "default", label: "gmail" }]);
  expect(withLegacy([], false)).toEqual([]);
  const registered: Account[] = [{ provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" }];
  expect(withLegacy(registered, true)).toEqual(registered);
  // An Outlook-only registry still adopts the stray Gmail token.
  const outlook: Account[] = [{ provider: "outlook", id: "ada@work.com", label: "ada@work.com" }];
  expect(withLegacy(outlook, true).map((a) => a.id)).toEqual(["default", "ada@work.com"]);
});

test("findAccount resolves by address, by provider, and by prefix", () => {
  const accounts: Account[] = [
    { provider: "gmail", id: "ada@gmail.com", label: "ada@gmail.com" },
    { provider: "outlook", id: "grace@work.com", label: "grace@work.com" },
  ];
  expect(findAccount(accounts, "ADA@gmail.com")?.id).toBe("ada@gmail.com");
  expect(findAccount(accounts, "outlook")?.id).toBe("grace@work.com");
  expect(findAccount(accounts, "grace")?.id).toBe("grace@work.com");
  expect(findAccount(accounts, "nobody")).toBeNull();
  expect(findAccount(accounts, "")).toBeNull();
});

test("listInbox merges every connected account into one newest-first page", async () => {
  setProviders([
    fake("ada@gmail.com", "gmail", [
      { threads: [{ id: "g1", from: "GitHub", subject: "PR", snippet: "", date: "", ts: 300, unread: true }] },
    ]),
    fake("grace@work.com", "outlook", [
      { threads: [{ id: "o1", from: "Grace", subject: "standup", snippet: "", date: "", ts: 400, unread: false }] },
    ]),
  ]);

  const page = await listInbox("in:inbox", 20);
  expect(page.threads.map((t) => t.id)).toEqual(["o1", "g1"]);
  expect(page.threads[0]!.account).toBe("grace@work.com");
  expect(page.threads[0]!.provider).toBe("outlook");
  expect(page.errors).toEqual([]);
});

test("listInbox scopes to one account with `only`", async () => {
  setProviders([
    fake("ada@gmail.com", "gmail", [
      { threads: [{ id: "g1", from: "GitHub", subject: "PR", snippet: "", date: "", ts: 1, unread: false }] },
    ]),
    fake("grace@work.com", "outlook", [
      { threads: [{ id: "o1", from: "Grace", subject: "standup", snippet: "", date: "", ts: 2, unread: false }] },
    ]),
  ]);

  const page = await listInbox("in:inbox", 20, { only: "ada@gmail.com" });
  expect(page.threads.map((t) => t.id)).toEqual(["g1"]);
});

test("one failing mailbox never empties the list — it reports alongside the rest", async () => {
  setProviders([
    fake("ada@gmail.com", "gmail", [
      { threads: [{ id: "g1", from: "GitHub", subject: "PR", snippet: "", date: "", ts: 1, unread: false }] },
    ]),
    fake("grace@work.com", "outlook", [], { fail: "graph 401: token expired" }),
  ]);

  const page = await listInbox("in:inbox", 20);
  expect(page.threads.map((t) => t.id)).toEqual(["g1"]);
  expect(page.errors).toEqual([{ account: "grace@work.com", message: "graph 401: token expired" }]);
});

test("cursors page only the accounts that still have mail", async () => {
  setProviders([
    fake("ada@gmail.com", "gmail", [
      {
        threads: [{ id: "g1", from: "GitHub", subject: "PR", snippet: "", date: "", ts: 3, unread: false }],
        nextPageToken: "1",
      },
      { threads: [{ id: "g2", from: "GitHub", subject: "PR 2", snippet: "", date: "", ts: 2, unread: false }] },
    ]),
    fake("grace@work.com", "outlook", [
      { threads: [{ id: "o1", from: "Grace", subject: "standup", snippet: "", date: "", ts: 1, unread: false }] },
    ]),
  ]);

  const first = await listInbox("in:inbox", 20);
  expect(first.threads.map((t) => t.id)).toEqual(["g1", "o1"]);
  expect(first.cursors).toEqual({ "ada@gmail.com": "1" }); // Outlook is exhausted

  const second = await listInbox("in:inbox", 20, { cursors: first.cursors });
  expect(second.threads.map((t) => t.id)).toEqual(["g2"]); // only Gmail was asked
  expect(second.cursors).toEqual({});
});

// --- the write side ----------------------------------------------------------

interface Journal {
  sent: MailDraft[];
  drafts: MailDraft[];
  read: Array<{ id: string; read: boolean }>;
  archived: string[];
  trashed: string[];
  labelled: Array<{ id: string; name: string }>;
}

/** A provider that writes to an array instead of a mailbox. */
function writable(account: string, journal: Journal, opts: { fail?: Error; drafts?: StoredDraft[] } = {}): MailProvider {
  const boom = () => {
    if (opts.fail) throw opts.fail;
  };
  return {
    id: "gmail",
    account,
    async listInbox() {
      return { threads: [] };
    },
    async getThread(id) {
      return { id, subject: "", messages: [] };
    },
    async send(draft) {
      boom();
      journal.sent.push(draft);
      return { id: `sent-${journal.sent.length}` };
    },
    async saveDraft(draft) {
      boom();
      journal.drafts.push(draft);
      return { id: `draft-${journal.drafts.length}` };
    },
    async listDrafts() {
      return opts.drafts ?? [];
    },
    async markRead(id, read) {
      boom();
      journal.read.push({ id, read });
    },
    async archive(id) {
      boom();
      journal.archived.push(id);
    },
    async trash(id) {
      journal.trashed.push(id);
    },
    async label(id, name) {
      boom();
      journal.labelled.push({ id, name });
    },
  };
}

const journal = (): Journal => ({ sent: [], drafts: [], read: [], archived: [], trashed: [], labelled: [] });

test("a write goes to the mailbox that owns the thread, not the first one", async () => {
  const ada = journal();
  const grace = journal();
  setProviders([writable("ada@gmail.com", ada), writable("grace@work.com", grace)]);

  await sendMail("grace@work.com", { to: ["bob@z.com"], subject: "hi", body: "yo" });
  await markRead("ada@gmail.com", "t1", true);
  await archiveThread("ada@gmail.com", "t2");
  await labelThread("grace@work.com", "t3", "todo");
  await saveDraft("ada@gmail.com", { to: [], subject: "later", body: "" });

  expect(grace.sent.map((d) => d.subject)).toEqual(["hi"]);
  expect(ada.sent).toEqual([]);
  expect(ada.read).toEqual([{ id: "t1", read: true }]);
  expect(ada.archived).toEqual(["t2"]);
  expect(grace.labelled).toEqual([{ id: "t3", name: "todo" }]);
  expect(ada.drafts.map((d) => d.subject)).toEqual(["later"]);
});

test("a backend without the method says so, instead of crashing", async () => {
  setProviders([
    {
      id: "outlook",
      account: "grace@work.com",
      async listInbox() {
        return { threads: [] };
      },
      async getThread(id): Promise<OpenThread> {
        return { id, subject: "", messages: [] };
      },
    },
  ]);
  const boom = sendMail("grace@work.com", { to: ["a@x.com"], subject: "hi", body: "" });
  await expect(boom).rejects.toThrow(MailWriteUnsupported);
  await expect(boom).rejects.toThrow("outlook cannot send mail");
});

test("listDrafts merges every mailbox newest-first and survives one failing", async () => {
  const ada: StoredDraft[] = [{ id: "d1", to: ["a@x.com"], subject: "old", body: "", ts: 100 }];
  const grace: StoredDraft[] = [{ id: "d2", to: ["b@y.com"], subject: "new", body: "", ts: 200 }];
  setProviders([
    writable("ada@gmail.com", journal(), { drafts: ada }),
    writable("grace@work.com", journal(), { drafts: grace }),
  ]);

  const page = await listDrafts(20);
  expect(page.drafts.map((d) => d.subject)).toEqual(["new", "old"]);
  expect(page.drafts[0]!.account).toBe("grace@work.com");
  expect(page.errors).toEqual([]);

  const scoped = await listDrafts(20, { only: "ada@gmail.com" });
  expect(scoped.drafts.map((d) => d.id)).toEqual(["d1"]);
});

test("isScopeError picks the reconnect case out of an ordinary failure", () => {
  expect(isScopeError(new Error("gmail 403: Request had insufficient authentication scopes"))).toBe(true);
  expect(isScopeError(new Error("gmail 403: ACCESS_TOKEN_SCOPE_INSUFFICIENT"))).toBe(true);
  expect(isScopeError(new Error("graph 403: ErrorAccessDenied"))).toBe(true);
  expect(isScopeError(new Error("gmail 404: not found"))).toBe(false);
  expect(isScopeError(new Error("fetch failed"))).toBe(false);
  expect(scopeHint("gmail")).toBe("reconnect for write access: kona login gmail");
});
