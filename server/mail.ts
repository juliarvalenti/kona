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
  /** Display name, for the reader ("Ada Lovelace"). */
  from: string;
  /** The bare mailbox behind that name — what a reply is addressed to. */
  fromAddress?: string;
  /** Reply-To, when the sender set one; it wins over `fromAddress`. */
  replyTo?: string;
  /** The other recipients, so reply-all can keep them. */
  to?: string[];
  cc?: string[];
  date: string;
  body: string;
  /** Provider message id — Graph replies are addressed to a message, not a thread. */
  id?: string;
  /** RFC Message-ID, for the In-Reply-To/References headers of a reply. */
  messageId?: string;
  references?: string;
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
 * One outgoing message. Compose, reply and forward all produce this shape —
 * written once against the seam rather than twice against two APIs — and
 * server/compose.ts turns a thread into one.
 */
export interface MailDraft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Thread being replied to, when this is a reply rather than a new message. */
  replyTo?: string;
  /**
   * The message being answered. Gmail threads on the RFC headers; Graph replies
   * to a message id. Carrying both keeps the seam provider-agnostic.
   */
  inReplyTo?: { id?: string; messageId?: string; references?: string };
  /** The provider draft this edits; absent creates a new one. */
  draftId?: string;
}

/** A saved draft as the provider hands it back, ready to reopen in the composer. */
export interface StoredDraft {
  id: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Epoch ms of the last save, so the list can sort newest-first. */
  ts: number;
}

/**
 * What every mailbox backend implements.
 *
 * Reading is required. The write half is optional ONLY so a stub (a test fake,
 * a future read-only backend) can exist — Gmail and Outlook both implement all
 * of it, and the seam turns a missing method into `MailWriteUnsupported` rather
 * than a crash.
 */
export interface MailProvider {
  readonly id: ProviderId;
  /** The connected mailbox this instance speaks for, e.g. "ada@gmail.com". */
  readonly account: string;
  listInbox(query: string, max: number, pageToken?: string): Promise<InboxPage>;
  getThread(id: string): Promise<OpenThread>;
  /** Send it now. */
  send?(draft: MailDraft): Promise<{ id?: string }>;
  /** Park it in the provider's Drafts folder (or update `draft.draftId`). */
  saveDraft?(draft: MailDraft): Promise<{ id: string }>;
  /** Send a draft that is already saved. */
  sendDraft?(id: string): Promise<void>;
  listDrafts?(max: number): Promise<StoredDraft[]>;
  /** Clear or set the unread flag on a whole thread. */
  markRead?(id: string, read: boolean): Promise<void>;
  /** Out of the inbox, still in the mailbox. */
  archive?(id: string): Promise<void>;
  trash?(id: string): Promise<void>;
  /** Apply a label (Gmail) / category (Outlook), creating it if need be. */
  label?(id: string, name: string): Promise<void>;
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
  // No mailbox at all under test unless one was injected: the accounts on this
  // machine are a real human's (see server/transport.ts and #41).
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

// --- the write side ----------------------------------------------------------

/**
 * A provider that cannot do this — a stub backend, or a build where the method
 * was never wired. Distinct from a network failure, because the answer is
 * "never", not "try again".
 */
export class MailWriteUnsupported extends Error {
  constructor(readonly action: string, readonly provider: string) {
    super(`${provider} cannot ${action} from kona`);
    this.name = "MailWriteUnsupported";
  }
}

/**
 * A write refused for want of an OAuth scope, rather than for want of
 * permission on the mailbox. Both providers say it in their own dialect; the
 * applet needs the one bit — "reconnect this account".
 */
export function isScopeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    /insufficient(authentication)?\s*(scopes?|permissions?)/i.test(msg) ||
    /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|ErrorAccessDenied/i.test(msg) ||
    (/\b403\b/.test(msg) && /scope|permission/i.test(msg))
  );
}

/** What to tell a human whose token predates the write scopes. */
export function scopeHint(provider: ProviderId): string {
  return `reconnect for write access: kona login ${provider}`;
}

/**
 * Call one provider method, or explain that this backend hasn't got it. The
 * `!` in each caller is what the guard above just proved.
 */
async function act(
  account: string,
  method: keyof MailProvider,
  action: string,
  run: (p: MailProvider) => Promise<any>,
): Promise<any> {
  const p = await provider(account);
  if (typeof p[method] !== "function") throw new MailWriteUnsupported(action, p.id);
  return run(p);
}

/** Send a message from one mailbox. */
export async function sendMail(account: string, draft: MailDraft): Promise<{ id?: string }> {
  return act(account, "send", "send mail", (p) => p.send!(draft));
}

/** Park a draft with the provider (or update the one `draft.draftId` names). */
export async function saveDraft(account: string, draft: MailDraft): Promise<{ id: string }> {
  return act(account, "saveDraft", "save drafts", (p) => p.saveDraft!(draft));
}

/** Send a draft that is already saved provider-side. */
export async function sendDraft(account: string, id: string): Promise<void> {
  return act(account, "sendDraft", "send drafts", (p) => p.sendDraft!(id));
}

/** A draft, tagged with the mailbox it is saved in. */
export interface UnifiedDraft extends StoredDraft {
  account: string;
  provider: ProviderId;
}

/**
 * Drafts from every connected account (or just one), newest first. Same
 * fan-out shape as `listInbox`: one dead mailbox reports, it doesn't empty the
 * list, and a provider without drafts is simply skipped.
 */
export async function listDrafts(
  max = 20,
  opts: { only?: string | null } = {},
): Promise<{ drafts: UnifiedDraft[]; errors: UnifiedPage["errors"] }> {
  let live = await providers();
  if (opts.only) live = live.filter((p) => p.account === opts.only);
  const errors: UnifiedPage["errors"] = [];
  const drafts: UnifiedDraft[] = [];
  await Promise.all(
    live.map(async (p) => {
      if (typeof p.listDrafts !== "function") return;
      try {
        for (const d of await p.listDrafts(max)) drafts.push({ ...d, account: p.account, provider: p.id });
      } catch (e) {
        errors.push({ account: p.account, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  drafts.sort((a, b) => b.ts - a.ts || a.account.localeCompare(b.account) || a.id.localeCompare(b.id));
  return { drafts, errors };
}

/** Clear (or set) the unread flag on a thread. */
export async function markRead(account: string, id: string, read = true): Promise<void> {
  return act(account, "markRead", "mark mail read", (p) => p.markRead!(id, read));
}

/** Out of the inbox, still in the mailbox. */
export async function archiveThread(account: string, id: string): Promise<void> {
  return act(account, "archive", "archive mail", (p) => p.archive!(id));
}

export async function trashThread(account: string, id: string): Promise<void> {
  return act(account, "trash", "trash mail", (p) => p.trash!(id));
}

/** Apply a label (Gmail) / category (Outlook), creating it when it is new. */
export async function labelThread(account: string, id: string, name: string): Promise<void> {
  return act(account, "label", "label mail", (p) => p.label!(id, name));
}
