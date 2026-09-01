import { join } from "node:path";
import { readFileSync } from "node:fs";
import { configDir } from "../core/config.ts";
import { kcGet } from "./keychain.ts";

/**
 * The mail seam. `email` talks to THIS file, never to Gmail or Graph directly:
 * a provider is anything that can list an inbox and open a thread, so adding a
 * mailbox is adding a `MailProvider`, not touching the applet.
 *
 * Two things live here that a single-provider client never needed:
 *
 *   accounts   You can connect several mailboxes at once (two Gmails, a Gmail
 *              and an Outlook). The list persists in ~/.config/kona/accounts.json;
 *              each account's refresh token sits in the keychain under
 *              (kona-<provider>, <address>). Mail itself never hits disk.
 *   unified    listInbox() fans out to every connected account in parallel and
 *              merges the rows newest-first, each tagged with the account it
 *              came from, so opens and actions route back to the right provider.
 */

export type ProviderId = "gmail" | "outlook";

/** A row in the list: one conversation, flattened to what the list draws. */
export interface MailThread {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  /** As the provider gave it (RFC-2822 for Gmail, ISO-8601 for Graph). */
  date: string;
  /** Epoch ms, so rows from different providers sort against each other. */
  ts: number;
  unread: boolean;
}

export interface MailMessage {
  from: string;
  date: string;
  body: string;
}

export interface OpenThread {
  id: string;
  subject: string;
  messages: MailMessage[];
}

export interface InboxPage {
  threads: MailThread[];
  /** Opaque, provider-defined: a Gmail page token or a Graph nextLink. */
  nextPageToken?: string;
}

/**
 * A draft, for when compose/reply lands (#11). The shape is part of the
 * contract now so compose is written once against the seam rather than twice
 * against two APIs; providers that cannot send simply omit `send`.
 */
export interface MailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Thread being replied to, when this is a reply rather than a new message. */
  replyTo?: string;
}

/** What every mailbox backend implements. Read is required; send is #11. */
export interface MailProvider {
  readonly id: ProviderId;
  /** The connected mailbox this instance speaks for, e.g. "ada@gmail.com". */
  readonly account: string;
  listInbox(query: string, max: number, pageToken?: string): Promise<InboxPage>;
  getThread(id: string): Promise<OpenThread>;
  /** Optional today; compose (#11) fills these in for both providers. */
  send?(draft: MailDraft): Promise<void>;
  saveDraft?(draft: MailDraft): Promise<{ id: string }>;
}

// --- accounts ----------------------------------------------------------------

export interface Account {
  provider: ProviderId;
  /** Mailbox address, which is also the keychain account name. */
  id: string;
  /** What the UI shows on a row badge. Defaults to the address. */
  label: string;
  addedAt?: number;
}

const ACCOUNTS_FILE = () => join(configDir(), "accounts.json");

/** Keychain service per provider; the account name is the mailbox address. */
export function kcService(provider: ProviderId): string {
  return `kona-${provider}`;
}

/**
 * kona stored exactly one Gmail token before accounts existed, under the fixed
 * name "refresh-token". That entry keeps working: it reads as the account
 * `default` until the next `kona login` writes a real address.
 */
export const LEGACY_ACCOUNT = "default";

export function kcAccountName(accountId: string): string {
  return accountId === LEGACY_ACCOUNT ? "refresh-token" : accountId;
}

export function readAccountsFile(): Account[] {
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE(), "utf8")) as { accounts?: unknown } | unknown[];
    const list = Array.isArray(raw) ? raw : (raw?.accounts ?? []);
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (a): a is Account =>
          !!a &&
          typeof a === "object" &&
          ((a as Account).provider === "gmail" || (a as Account).provider === "outlook") &&
          typeof (a as Account).id === "string" &&
          !!(a as Account).id,
      )
      .map((a) => ({ ...a, label: a.label || a.id }));
  } catch {
    return []; // absent or malformed: no accounts, same as a fresh install
  }
}

async function writeAccountsFile(accounts: Account[]): Promise<void> {
  await Bun.write(ACCOUNTS_FILE(), JSON.stringify({ accounts }, null, 2) + "\n");
}

/**
 * The registry plus any pre-accounts Gmail token, deduped. Pure so the upgrade
 * path is testable without a keychain.
 */
export function withLegacy(registry: Account[], hasLegacyGmail: boolean): Account[] {
  const out = [...registry];
  if (hasLegacyGmail && !out.some((a) => a.provider === "gmail")) {
    out.unshift({ provider: "gmail", id: LEGACY_ACCOUNT, label: "gmail" });
  }
  return out;
}

/** Every connected account, in the order they were added. */
export function listAccounts(): Account[] {
  const hasLegacy = kcGet(kcService("gmail"), kcAccountName(LEGACY_ACCOUNT)) !== null;
  return withLegacy(readAccountsFile(), hasLegacy);
}

/** Remember a mailbox after a successful login (idempotent). */
export async function addAccount(provider: ProviderId, id: string, label = id): Promise<Account> {
  const account: Account = { provider, id, label, addedAt: Date.now() };
  const rest = readAccountsFile().filter((a) => !(a.provider === provider && a.id === id));
  await writeAccountsFile([...rest, account]);
  return account;
}

export async function removeAccount(provider: ProviderId, id: string): Promise<void> {
  await writeAccountsFile(readAccountsFile().filter((a) => !(a.provider === provider && a.id === id)));
}

/** Resolve "which account did the user mean" for logout / filter arguments. */
export function findAccount(accounts: Account[], want: string): Account | null {
  const q = want.trim().toLowerCase();
  if (!q) return null;
  return (
    accounts.find((a) => a.id.toLowerCase() === q) ??
    accounts.find((a) => a.provider === q) ??
    accounts.find((a) => a.id.toLowerCase().startsWith(q)) ??
    null
  );
}

// --- provider instances ------------------------------------------------------

// Tests (and the fake-provider mode the suite runs in) swap the live backends
// out here rather than reaching into Gmail/Graph.
let injected: MailProvider[] | null = null;

/** Test seam: pass providers to use, or null to go back to the real ones. */
export function setProviders(list: MailProvider[] | null): void {
  injected = list;
}

export async function providers(): Promise<MailProvider[]> {
  if (injected) return injected;
  if (process.env.KONA_FAKE_PROVIDERS) return [];
  const accounts = listAccounts();
  if (!accounts.length) return [];
  const [{ GmailProvider }, { OutlookProvider }] = await Promise.all([
    import("./gmail.ts"),
    import("./outlook.ts"),
  ]);
  return accounts.map((a) => (a.provider === "gmail" ? new GmailProvider(a.id) : new OutlookProvider(a.id)));
}

async function provider(account: string): Promise<MailProvider> {
  const all = await providers();
  const hit = all.find((p) => p.account === account) ?? (all.length === 1 ? all[0] : undefined);
  if (!hit) throw new Error(`no connected account "${account}" — run \`kona login\``);
  return hit;
}

// --- unified inbox -----------------------------------------------------------

/** A list row, tagged with where it came from. */
export interface UnifiedThread extends MailThread {
  account: string;
  provider: ProviderId;
}

export interface UnifiedPage {
  threads: UnifiedThread[];
  /** Per-account continuation tokens; an account with none is exhausted. */
  cursors: Record<string, string>;
  /** Per-account failures: one dead mailbox must not empty the whole list. */
  errors: Array<{ account: string; message: string }>;
  /** Accounts that answered (or failed) — i.e. what was actually connected. */
  accounts: Account[];
}

/** Newest first; ties broken by account then id so the order is stable. */
export function mergeThreads(rows: UnifiedThread[]): UnifiedThread[] {
  return [...rows].sort((a, b) => b.ts - a.ts || a.account.localeCompare(b.account) || a.id.localeCompare(b.id));
}

/** Stable row key across providers — `open` routes on this, not on an index. */
export function threadKey(t: { account: string; id: string }): string {
  return `${t.account} ${t.id}`;
}

/**
 * Fetch one page from every connected account (optionally just one) and merge.
 * `cursors` continues a previous page: only accounts with a token are asked, so
 * "more" pages the accounts that still have mail without restarting the others.
 */
export async function listInbox(
  query = "in:inbox",
  max = 20,
  opts: { cursors?: Record<string, string>; only?: string | null } = {},
): Promise<UnifiedPage> {
  const accounts = listAccounts();
  let live = await providers();
  if (opts.only) live = live.filter((p) => p.account === opts.only);
  if (opts.cursors) live = live.filter((p) => opts.cursors![p.account]);

  const errors: UnifiedPage["errors"] = [];
  const cursors: Record<string, string> = {};
  const rows: UnifiedThread[] = [];

  await Promise.all(
    live.map(async (p) => {
      try {
        const page = await p.listInbox(query, max, opts.cursors?.[p.account]);
        for (const t of page.threads) rows.push({ ...t, account: p.account, provider: p.id });
        if (page.nextPageToken) cursors[p.account] = page.nextPageToken;
      } catch (e) {
        errors.push({ account: p.account, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return { threads: mergeThreads(rows), cursors, errors, accounts };
}

export async function getThread(account: string, id: string): Promise<OpenThread> {
  return (await provider(account)).getThread(id);
}
