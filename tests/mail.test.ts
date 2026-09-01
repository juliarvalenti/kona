import { test, expect, afterEach } from "bun:test";
import {
  findAccount,
  kcAccountName,
  kcService,
  listInbox,
  mergeThreads,
  setProviders,
  threadKey,
  withLegacy,
  type Account,
  type InboxPage,
  type MailProvider,
  type OpenThread,
  type UnifiedThread,
} from "../server/mail.ts";

/** The provider seam: accounts, the merge, and the fan-out — no network. */

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
