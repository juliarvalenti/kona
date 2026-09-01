import {
  defineApplet,
  text,
  spacer,
  col,
  input,
  theme,
  appletAccent,
  appletBool,
  appletNumber,
  type AppletCtx,
  type ViewNode,
} from "../../sdk/index.ts";
import { keyValue, divider, recordRow, modal, field as labelled, toast } from "../../sdk/components.ts";
import {
  listInbox,
  getThread,
  listAccounts,
  listDrafts,
  findAccount,
  threadKey,
  mergeThreads,
  sendMail,
  saveDraft,
  sendDraft,
  markRead as providerMarkRead,
  archiveThread,
  trashThread,
  labelThread,
  isScopeError,
  scopeHint,
  MailWriteUnsupported,
  type Account,
  type MailDraft,
  type OpenThread,
  type ProviderId,
  type UnifiedDraft,
  type UnifiedThread,
} from "../../server/mail.ts";
import { draftSummary, forwardDraft, parseAddresses, replyDraft } from "../../server/compose.ts";
import { notify, freshIds } from "../../server/notify.ts";

/** Threads per fetch, per account. `[applets.email] page = 50` raises it. */
const PAGE = Math.max(1, Math.min(100, Math.round(appletNumber("email", "page", 20))));

/**
 * email — a mail client in the terminal, across providers.
 *
 * You browse the merged inbox with j/k, open a thread with enter, and then
 * *act*: reply, reply-all, forward, write a new message, archive, trash,
 * label, toggle unread. The daemon owns the OAuth tokens and every one of
 * those actions goes through the `MailProvider` seam in server/mail.ts, so
 * Gmail and Outlook get the same client and neither is special-cased here.
 *
 * Bimodal all the way down. The composer is a modal of `input` nodes whose
 * values live in state, and the verb the field's enter fires is the verb an
 * agent posts:
 *
 *   kona call email compose '{"to":"ada@x.com","subject":"hi","body":"…"}'
 *   kona call email reply '{"id":"18f…","body":"on it"}'
 *   kona call email archive '{"id":"18f…"}'
 *
 * Several accounts at once are the normal case: rows from every mailbox are
 * merged newest-first and tagged with a badge, and every row carries the
 * account it came from, so a reply leaves from the mailbox it arrived in.
 */

/** The composer's fields, in tab order. */
const FIELDS = ["to", "cc", "subject", "body"] as const;
type ComposeField = (typeof FIELDS)[number];

type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

interface ComposeValues {
  to: string;
  cc: string;
  subject: string;
  body: string;
}

interface Compose {
  mode: ComposeMode;
  /** Which field has the keyboard. */
  field: ComposeField;
  values: ComposeValues;
  /** The mailbox this leaves from — a reply answers from where it landed. */
  account: string;
  /** Thread being answered, for provider-side threading. */
  replyTo?: string;
  inReplyTo?: MailDraft["inReplyTo"];
  /** The provider draft this edits, once it has been saved. */
  draftId?: string;
  /**
   * Bumped on every committed body line. It keys the body field, and a new key
   * is how the host knows to drop the line you just finished typing.
   */
  line: number;
  /** The body line being typed. State, so tabbing away doesn't eat it. */
  pending: string;
  sending: boolean;
}

/** A one-field question a verb needs answered before it can act. */
interface Prompt {
  kind: "label";
  value: string;
  account: string;
  id: string;
}

interface EmailState {
  threads: UnifiedThread[];
  cursor: number;
  query: string;
  /** Account id the list is scoped to; null = the unified inbox. */
  filter: string | null;
  accounts: Account[];
  open: OpenThread | null;
  /** Which account the open thread belongs to (routing, and the header). */
  openAccount: string | null;
  loading: boolean;
  error: string | null;
  authed: boolean;
  syncedAt: number;
  /** Per-account continuation tokens; empty = nothing more to load. */
  cursors: Record<string, string>;

  // --- the write side
  /** The composer, when one is open. Its values are state: agents see them. */
  compose: Compose | null;
  /** The composer you closed with something in it — `n` picks it back up. */
  stash: Compose | null;
  prompt: Prompt | null;
  /** Saved drafts, when the list is showing them. */
  drafts: UnifiedDraft[];
  showDrafts: boolean;
  /** Transient banner: "sent", "archived", why a write failed. */
  notice: string | null;
  noticeAt: number;
  /** Set when a provider refused a write for want of a scope: reconnect. */
  scopeNeeded: ProviderId | null;
}

/** Every color is a theme role; `[applets.email] accent` retints the frame. */
const palette = () => {
  const t = theme();
  return { ACCENT: appletAccent("email", t.accent), FG: t.fg, DIM: t.dim, AMBER: t.warn, RED: t.error, UNREAD: t.ok };
};

const NOTICE_MS = 5000;

/** Opening a thread marks it read. `[applets.email] autoRead = false` opts out. */
const autoRead = () => appletBool("email", "autoRead", true);

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Epoch ms -> "31 Aug" (compact for the list); falls back to the raw header. */
export function shortDate(ts: number, raw = ""): string {
  if (!ts) return raw.slice(0, 12);
  const d = new Date(ts);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${d.getDate()} ${month}`;
}

/** The badge on a row: the mailbox's local part, enough to tell two apart. */
export function accountBadge(account: string): string {
  if (account === "default") return "gmail";
  const local = account.split("@")[0] ?? account;
  return truncate(local, 10);
}

/** The field an input payload names: `{ id: "compose.body#3" }` -> "body". */
export function fieldOf(id: unknown): string {
  return String(id ?? "").split(".").pop()?.split("#")[0] ?? "";
}

/** The first non-empty string among the arg spellings a caller might use. */
function argText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) return v.join(", ");
  }
  return "";
}

// Unread threads we have already announced. null until the first successful
// load: signing in shouldn't banner an inbox you already have open elsewhere.
let announced: Set<string> | null = null;

/** Banner unread mail that arrived since the last sync; batch a flood into one. */
function announceUnread(threads: UnifiedThread[]) {
  const unread = threads.filter((t) => t.unread);
  const { seen, fresh } = freshIds(announced, unread.map(threadKey));
  announced = seen;
  if (!fresh.length) return;
  const rows = fresh.map((key) => unread.find((t) => threadKey(t) === key)!).filter(Boolean);
  if (rows.length > 3) {
    void notify({
      event: "email.unread",
      title: "Mail",
      body: `${rows.length} new unread messages`,
      key: `email.unread:batch:${rows.length}:${threadKey(rows[0]!)}`,
    });
    return;
  }
  for (const t of rows) {
    void notify({
      event: "email.unread",
      // With more than one mailbox connected, which one it landed in matters.
      title: t.from,
      body: t.subject,
      key: `email.unread:${threadKey(t)}`,
      dedupeMs: 6 * 3_600_000, // one banner per thread, not one per re-sync
    });
  }
}

/** Fold per-account failures into one line the frame can show. */
function summarize(errors: Array<{ account: string; message: string }>): string | null {
  if (!errors.length) return null;
  if (errors.length === 1) return `${accountBadge(errors[0]!.account)}: ${errors[0]!.message}`;
  return errors.map((e) => `${accountBadge(e.account)}: ${e.message}`).join("  ·  ");
}

function say(state: EmailState, notice: string) {
  state.notice = notice;
  state.noticeAt = Date.now();
}

/**
 * A write came back badly. A missing scope is the interesting case — the token
 * predates kona's write half — so it is remembered and the view says which
 * account to reconnect, rather than failing silently every time.
 */
function writeFailed(
  state: EmailState,
  e: unknown,
  what: string,
  provider?: ProviderId,
): Record<string, unknown> {
  const detail = e instanceof Error ? e.message : String(e);
  if (isScopeError(e) && provider) {
    state.scopeNeeded = provider;
    say(state, `${provider}: ${scopeHint(provider)}`);
    return { error: detail, scope: provider };
  }
  say(state, e instanceof MailWriteUnsupported ? detail : `couldn't ${what}: ${truncate(detail, 60)}`);
  return { error: detail };
}

/** (Re)load the first page. Used by refresh/search and the auto-refresh tick. */
async function loadInbox(state: EmailState, emit: () => void) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  emit();
  try {
    const page = await listInbox(state.query, PAGE, { only: state.filter });
    state.threads = page.threads;
    state.cursors = page.cursors;
    state.accounts = page.accounts;
    state.authed = page.accounts.length > 0;
    state.error = summarize(page.errors);
    state.cursor = Math.min(state.cursor, Math.max(0, state.threads.length - 1));
    // Only the inbox is "new mail"; a search for old threads is not.
    if (state.query === "in:inbox") announceUnread(state.threads);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.error = msg;
    if (/signed in|client credentials|not configured/i.test(msg)) state.authed = false;
  } finally {
    state.loading = false;
    state.syncedAt = Date.now();
    emit();
  }
}

/** Append the next page from every account that still has one. */
async function loadMore(state: EmailState, emit: () => void) {
  if (state.loading || !Object.keys(state.cursors).length) return;
  state.loading = true;
  emit();
  try {
    const page = await listInbox(state.query, PAGE, { cursors: state.cursors, only: state.filter });
    const seen = new Set(state.threads.map(threadKey));
    const added = page.threads.filter((t) => !seen.has(threadKey(t)));
    // Merged newest-first, but an older page can still interleave: keep the
    // list append-only so the cursor doesn't jump under the reader.
    state.threads = [...state.threads, ...added];
    state.cursors = page.cursors;
    state.error = summarize(page.errors);
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

async function loadDrafts(state: EmailState, emit: () => void) {
  state.loading = true;
  emit();
  try {
    const page = await listDrafts(PAGE, { only: state.filter });
    state.drafts = page.drafts;
    state.error = summarize(page.errors);
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

// --- targets -----------------------------------------------------------------

interface Target {
  account: string;
  id: string;
  /** Where it sits in the list, when it is on screen (optimistic updates). */
  index: number;
}

/**
 * Which thread a verb acts on: the one an agent named (`{account,id}`), the row
 * an index picks out (a click), the thread you have open, or the row under the
 * cursor. One resolver, so a keypress and a call can never disagree.
 */
function target(state: EmailState, args: Record<string, unknown>): Target | null {
  if (typeof args.id === "string" && args.id) {
    const row = state.threads.findIndex((t) => t.id === args.id);
    const account =
      (typeof args.account === "string" && args.account) ||
      state.threads[row]?.account ||
      (state.open?.id === args.id ? (state.openAccount ?? "") : "") ||
      state.filter ||
      state.accounts[0]?.id ||
      "";
    return { account, id: args.id, index: row };
  }
  if (typeof args.index === "number") {
    const row = state.threads[args.index];
    return row ? { account: row.account, id: row.id, index: args.index } : null;
  }
  if (state.open && state.openAccount) {
    return {
      account: state.openAccount,
      id: state.open.id,
      index: state.threads.findIndex((t) => t.id === state.open!.id),
    };
  }
  const row = state.threads[state.cursor];
  return row ? { account: row.account, id: row.id, index: state.cursor } : null;
}

/** The provider behind an account id, for the scope hint. */
function providerOf(state: EmailState, account: string): ProviderId | undefined {
  return state.accounts.find((a) => a.id === account)?.provider;
}

/** Drop a row from the list (archive, trash) and keep the cursor sane. */
function removeRow(state: EmailState, id: string) {
  state.threads = state.threads.filter((t) => t.id !== id);
  state.cursor = Math.max(0, Math.min(state.cursor, state.threads.length - 1));
  if (state.open?.id === id) {
    state.open = null;
    state.openAccount = null;
  }
}

// --- the composer ------------------------------------------------------------

const EMPTY: ComposeValues = { to: "", cc: "", subject: "", body: "" };

/** Open the composer, prefilled. Everything a human types is state from here. */
function openCompose(
  state: EmailState,
  mode: ComposeMode,
  values: Partial<ComposeValues>,
  opts: { account?: string; replyTo?: string; inReplyTo?: MailDraft["inReplyTo"]; draftId?: string } = {},
): Compose {
  const compose: Compose = {
    mode,
    field: values.to ? "body" : "to",
    values: { ...EMPTY, ...values },
    account: opts.account ?? state.openAccount ?? state.filter ?? state.accounts[0]?.id ?? "",
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
    ...(opts.draftId ? { draftId: opts.draftId } : {}),
    line: 0,
    pending: "",
    sending: false,
  };
  state.compose = compose;
  return compose;
}

/** Reopen a saved draft in the composer, still tied to its provider copy. */
function editDraft(state: EmailState, d: UnifiedDraft): Compose {
  return openCompose(
    state,
    "draft",
    { to: d.to.join(", "), cc: (d.cc ?? []).join(", "), subject: d.subject, body: d.body },
    { account: d.account, draftId: d.id },
  );
}

/** The composer's values as the draft a provider takes. */
function toDraft(c: Compose): MailDraft {
  return {
    to: parseAddresses(c.values.to),
    cc: parseAddresses(c.values.cc),
    subject: c.values.subject,
    body: c.values.body,
    ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    ...(c.inReplyTo ? { inReplyTo: c.inReplyTo } : {}),
    ...(c.draftId ? { draftId: c.draftId } : {}),
  };
}

/** Add the line just typed to the body, and key the field for the next one. */
function commitLine(c: Compose, line: string) {
  c.pending = "";
  if (!line.trim()) return;
  c.values.body = c.values.body ? `${c.values.body}\n${line}` : line;
  c.line += 1; // a new field id, so the host starts the next line empty
}

/** True when there is anything worth keeping in the composer. */
function hasContent(v: ComposeValues): boolean {
  return !!(v.to.trim() || v.cc.trim() || v.subject.trim() || v.body.trim());
}

/**
 * Closing a composer with something in it keeps it whole — mode, recipients,
 * the thread it answers — so picking it back up resumes a reply as a reply.
 */
function stash(state: EmailState) {
  const c = state.compose;
  if (!c || !hasContent(c.values)) return;
  state.stash = { ...c, sending: false };
  say(state, "composer closed — press n to pick it up again");
}

type Ctx = AppletCtx<EmailState>;

/**
 * Send what the composer holds. Factored out of the verbs so the field's enter,
 * `email.compose {to,…}` and `email.reply {body}` all commit through exactly
 * the same code — a dialog is only ever a way to fill in the arguments.
 */
async function doSend({ state, emit }: Ctx): Promise<Record<string, unknown>> {
  const c = state.compose;
  if (!c) return { error: "nothing to send" };
  const draft = toDraft(c);
  if (!draft.to.length) {
    say(state, "who to? fill in the To field");
    c.field = "to";
    emit();
    return { sent: false, error: "no recipient" };
  }
  c.sending = true;
  emit();
  try {
    // A draft the provider already holds is sent as that draft, so it doesn't
    // linger in Drafts as a copy of what you just sent.
    if (c.draftId) {
      await saveDraft(c.account, draft);
      await sendDraft(c.account, c.draftId);
    } else {
      await sendMail(c.account, draft);
    }
    state.compose = null;
    state.stash = null;
    state.scopeNeeded = null;
    say(state, `sent: ${draftSummary(draft)}`);
    emit();
    return { sent: true, to: draft.to, subject: draft.subject, account: c.account };
  } catch (e) {
    c.sending = false;
    emit();
    return writeFailed(state, e, "send", providerOf(state, c.account));
  }
}

/**
 * Answer a thread. Shared by `reply` and `replyAll` (and by the `enter` a
 * reader presses), because the two differ by exactly one flag.
 */
async function doReply(ctx: Ctx, args: Record<string, unknown>, all: boolean): Promise<Record<string, unknown>> {
  const { state, emit } = ctx;
  const hit = target(state, args);
  if (!hit) return { error: "no thread to reply to" };
  // An agent can reply to a thread it never opened.
  const thread = state.open?.id === hit.id ? state.open : await getThread(hit.account, hit.id);
  const prefill = replyDraft(thread, { all, me: hit.account });
  const body = argText(args, "body", "text", "message", "value");
  const c = openCompose(
    state,
    all ? "replyAll" : "reply",
    {
      to: prefill.to.join(", "),
      cc: (prefill.cc ?? []).join(", "),
      subject: prefill.subject,
      body: body ? `${body}\n${prefill.body}` : prefill.body,
    },
    {
      account: hit.account,
      ...(prefill.replyTo ? { replyTo: prefill.replyTo } : {}),
      ...(prefill.inReplyTo ? { inReplyTo: prefill.inReplyTo } : {}),
    },
  );
  c.field = "body";
  if (!body) {
    emit();
    return { dialog: "compose", to: prefill.to, subject: prefill.subject };
  }
  return doSend(ctx);
}

/** Save the composer to the provider's Drafts folder (creating or updating). */
async function doSaveDraft({ state, emit }: Ctx): Promise<Record<string, unknown>> {
  const c = state.compose;
  if (!c) return { error: "nothing to save" };
  try {
    const { id } = await saveDraft(c.account, toDraft(c));
    c.draftId = id;
    say(state, `draft saved: ${draftSummary(toDraft(c))}`);
    emit();
    return { saved: true, id, account: c.account };
  } catch (e) {
    return writeFailed(state, e, "save the draft", providerOf(state, c.account));
  }
}

/** Open a thread, and (unless you opted out) clear its unread dot. */
async function openThread(state: EmailState, emit: () => void, account: string, id: string) {
  state.loading = true;
  emit();
  try {
    state.open = await getThread(account, id);
    state.openAccount = account;
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
  const row = state.threads.find((t) => t.id === id);
  if (state.open && autoRead() && row?.unread) {
    // Optimistic: the dot clears the moment you open the thread, and the
    // provider catches up. A failure here is not worth interrupting a read.
    row.unread = false;
    emit();
    try {
      await providerMarkRead(account, id, true);
    } catch (e) {
      row.unread = true;
      emit();
      if (isScopeError(e)) {
        const provider = providerOf(state, account);
        if (provider) state.scopeNeeded = provider;
      }
    }
  }
}

export default defineApplet<EmailState>({
  id: "email",
  title: "Email",
  summary: "Read, write, reply and file mail from Gmail and Outlook in one list.",
  icon: "✉",
  tint: "#f7768e", // envelope rose
  labels: ["mail", "network"],
  requires: ["a mailbox: `kona login gmail` or `kona login outlook`"],
  // Both providers are this applet's business, so `kona login gmail` is wired
  // here — the CLI has no provider table of its own. Imported lazily: the OAuth
  // module only loads when someone actually signs in.
  auth: {
    gmail: () => import("../../server/google.ts"),
    outlook: () => import("../../server/microsoft.ts"),
  },
  notifications: {
    "email.unread": { summary: "unread mail arrives", default: false },
  },
  configSample: `[applets.email]
page = 20            # threads per fetch`,
  ephemeral: true, // mail lives in RAM only — never written to state.json
  initialState: {
    threads: [],
    cursor: 0,
    query: "in:inbox",
    filter: null,
    accounts: [],
    open: null,
    openAccount: null,
    loading: false,
    error: null,
    authed: false,
    syncedAt: 0,
    cursors: {},
    compose: null,
    stash: null,
    prompt: null,
    drafts: [],
    showDrafts: false,
    notice: null,
    noticeAt: 0,
    scopeNeeded: null,
  },

  docs: {
    refresh: "Reload the inbox. Call this before you read state.",
    search: { doc: "Run a Gmail query and replace the list with its results.", args: { q: "is:unread newer_than:1d" } },
    more: "Fetch the next page of threads.",
    open: { doc: "Open a thread by list `index` and load its body. Marks it read.", args: { index: 0 } },
    compose: {
      doc: "Send a new message. With no `to`, opens the composer instead.",
      args: { to: "ada@x.com", subject: "dinner", body: "friday?" },
    },
    reply: {
      doc: "Reply to a thread (`id`, or whatever is open). With no `body`, opens the composer prefilled.",
      args: { id: "18f2c…", body: "on it — shipping tonight." },
    },
    replyAll: { doc: "Reply keeping everyone else on the thread.", args: { id: "18f2c…", body: "thanks all" } },
    forward: { doc: "Forward a thread to someone else.", args: { id: "18f2c…", to: "grace@x.com" } },
    draft: {
      doc: "Save a message as a provider draft instead of sending it.",
      args: { to: "ada@x.com", subject: "dinner", body: "half-written…" },
    },
    drafts: "List saved drafts (and show them in place of the inbox).",
    send: "Send what the composer holds. Prefer compose/reply, which fill it in for you.",
    field: { doc: "The composer's plumbing: set one field. `compose.to`, `.cc`, `.subject`.", args: { id: "compose.to", value: "ada@x.com" } },
    next: "The composer's plumbing: move to the next field (what tab presses).",
    form: { doc: "The composer's plumbing: commit a field — on the body, a line; on an empty line, send.", args: { id: "compose.body", value: "friday?" } },
    dismiss: "Close the composer (or the label prompt), keeping what was typed.",
    openDraft: { doc: "Reopen a saved draft in the composer, by `index` or `id`.", args: { index: 0 } },
    archive: { doc: "Archive a thread — out of the inbox, still in the mailbox.", args: { id: "18f2c…" } },
    trash: { doc: "Move a thread to the trash.", args: { id: "18f2c…" } },
    label: {
      doc: "Apply a label (Gmail) / category (Outlook), creating it if it is new.",
      args: { id: "18f2c…", name: "todo" },
    },
    markRead: { doc: "Clear the unread dot on a thread.", args: { id: "18f2c…" } },
    markUnread: { doc: "Put it back.", args: { id: "18f2c…" } },
    toggleRead: { doc: "Flip a thread between read and unread.", args: { id: "18f2c…" } },
  },

  recipes: [
    {
      title: "Triage the inbox",
      steps: [
        `kona call email refresh`,
        `kona call email search '{"q":"is:unread newer_than:1d"}'   # -> { count: 12 }`,
        `kona state email                                            # threads[]: from, subject, snippet`,
        `kona call email open '{"index":0}'                          # -> the body, and the dot clears`,
        `kona call email archive '{"index":0}'                       # or trash / label / markUnread`,
      ],
      note: "Triage is reading AND filing: archive what is done, label what needs a human, leave the rest unread.",
    },
    {
      title: "Answer a thread",
      steps: [
        `kona call email open '{"index":0}'`,
        `kona call email reply '{"body":"on it — shipping tonight."}'   # replyAll keeps the cc list`,
        `kona call email compose '{"to":"ada@x.com","subject":"dinner","body":"friday?"}'`,
        `kona call email draft '{"to":"ada@x.com","subject":"dinner","body":"half-written…"}'`,
      ],
      note: "`reply` with no body opens the composer prefilled (quoted text and recipients) for the human instead — same verb, both callers.",
    },
  ],

  verbs: {
    async refresh(_args, { state, emit }) {
      if (state.showDrafts) await loadDrafts(state, emit);
      else await loadInbox(state, emit);
      return { count: state.threads.length, authed: state.authed, accounts: state.accounts.map((a) => a.id) };
    },
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "in:inbox");
      state.open = null;
      state.openAccount = null;
      state.showDrafts = false;
      state.cursor = 0;
      await loadInbox(state, emit);
      return { query: state.query, count: state.threads.length };
    },
    async more(_args, { state, emit }) {
      await loadMore(state, emit);
      return { count: state.threads.length, hasMore: Object.keys(state.cursors).length > 0 };
    },
    /** What is connected — an agent's way to learn the account ids. */
    accounts(_args, { state, emit }) {
      state.accounts = listAccounts();
      state.authed = state.accounts.length > 0;
      emit();
      return { accounts: state.accounts.map((a) => ({ id: a.id, provider: a.provider, label: a.label })) };
    },
    /**
     * Scope the list to one mailbox, or back to the unified inbox:
     * `{"id":"ada@gmail.com"}`, `{"id":"outlook"}` (by provider), `{}` for all.
     */
    async account(args, { state, emit }) {
      const want = args.id ?? args.account ?? args.name;
      if (want === undefined || want === null || want === "" || want === "all") {
        state.filter = null;
      } else {
        const accounts = state.accounts.length ? state.accounts : listAccounts();
        const hit = findAccount(accounts, String(want));
        if (!hit) return { error: `no such account: ${want}`, accounts: accounts.map((a) => a.id) };
        state.filter = hit.id;
      }
      state.cursor = 0;
      state.open = null;
      state.openAccount = null;
      await loadInbox(state, emit);
      return { filter: state.filter, count: state.threads.length };
    },
    // index selects a specific row (an agent's call, or a mouse click on a
    // row); {account,id} addresses a thread directly; without either, open
    // whatever the cursor is on. In the drafts list it reopens a draft.
    async open(args, ctx) {
      const { state, emit } = ctx;
      if (state.showDrafts) {
        const i = typeof args.index === "number" ? args.index : state.cursor;
        const d = typeof args.id === "string" ? state.drafts.find((x) => x.id === args.id) : state.drafts[i];
        if (!d) return { error: "no such draft" };
        state.cursor = Math.max(0, state.drafts.indexOf(d));
        editDraft(state, d);
        emit();
        return { draft: d.id, subject: d.subject };
      }
      const hit = target(state, args);
      if (!hit) return { error: "no such thread" };
      if (hit.index >= 0) state.cursor = hit.index;
      await openThread(state, emit, hit.account, hit.id);
      return { subject: state.open?.subject, account: hit.account };
    },
    /** Back out: the composer first, then the open thread, then the drafts view. */
    back(_args, { state, emit }) {
      if (state.compose) {
        stash(state);
        state.compose = null;
      } else if (state.prompt) {
        state.prompt = null;
      } else if (state.open) {
        state.open = null;
        state.openAccount = null;
      } else if (state.showDrafts) {
        state.showDrafts = false;
        state.cursor = 0;
      }
      emit();
    },
    down(_args, { state, emit }) {
      const rows = state.showDrafts ? state.drafts.length : state.threads.length;
      state.cursor = Math.min(rows - 1, state.cursor + 1);
      emit();
    },
    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    /** Cycle: unified -> each account in turn -> unified. What `a` presses. */
    async cycleAccount(_args, { state, emit }) {
      const accounts = state.accounts.length ? state.accounts : listAccounts();
      if (accounts.length < 2) return { filter: state.filter };
      const at = accounts.findIndex((a) => a.id === state.filter);
      state.filter = at === accounts.length - 1 ? null : (accounts[at + 1]?.id ?? null);
      state.cursor = 0;
      state.open = null;
      state.openAccount = null;
      await loadInbox(state, emit);
      return { filter: state.filter, count: state.threads.length };
    },

    // --- writing ------------------------------------------------------------

    /**
     * A new message. With a `to` it goes out now (an agent); with nothing it
     * opens the composer, resuming whatever you were writing (a keypress).
     */
    async compose(args, ctx) {
      const { state, emit } = ctx;
      const to = argText(args, "to", "recipient", "q");
      const account =
        argText(args, "account", "from") || state.stash?.account || state.openAccount || state.filter || "";
      const values: Partial<ComposeValues> = {
        to,
        cc: argText(args, "cc"),
        subject: argText(args, "subject", "title"),
        body: argText(args, "body", "text", "message"),
      };
      if (!to && !values.subject && !values.body && state.stash) {
        state.compose = { ...state.stash, sending: false };
        state.stash = null;
        emit();
        return { dialog: "compose", resumed: true };
      }
      const c = openCompose(state, "new", values, account ? { account } : {});
      if (!to) {
        emit();
        return { dialog: "compose" };
      }
      c.field = "body";
      return doSend(ctx);
    },

    /**
     * Answer a thread. With a `body` it sends; without one it opens the
     * composer with the recipients filled in and the message quoted below.
     */
    async reply(args, ctx) {
      return doReply(ctx, args, args.all === true || args.replyAll === true);
    },

    /** Reply, keeping everyone else on the thread. */
    async replyAll(args, ctx) {
      return doReply(ctx, args, true);
    },

    /** Forward a thread. With a `to` it sends; without one it opens the composer. */
    async forward(args, ctx) {
      const { state, emit } = ctx;
      const hit = target(state, args);
      if (!hit) return { error: "no thread to forward" };
      const thread = state.open?.id === hit.id ? state.open : await getThread(hit.account, hit.id);
      const prefill = forwardDraft(thread);
      const to = argText(args, "to", "recipient");
      const note = argText(args, "body", "text", "message");
      const c = openCompose(
        state,
        "forward",
        { to, subject: prefill.subject, body: note ? `${note}\n${prefill.body}` : prefill.body },
        { account: hit.account },
      );
      if (!to) {
        c.field = "to";
        emit();
        return { dialog: "compose", subject: prefill.subject };
      }
      return doSend(ctx);
    },

    /** Save a message as a provider draft — the composer's, or one you pass. */
    async draft(args, ctx) {
      const { state, emit } = ctx;
      if (!state.compose) {
        const account = argText(args, "account", "from") || state.filter || state.accounts[0]?.id || "";
        openCompose(
          state,
          "new",
          {
            to: argText(args, "to", "recipient"),
            cc: argText(args, "cc"),
            subject: argText(args, "subject", "title"),
            body: argText(args, "body", "text", "message"),
          },
          account ? { account } : {},
        );
      }
      const saved = await doSaveDraft(ctx);
      // An agent that handed us a whole message wants it parked, not a form.
      if (saved.saved && !args.keepOpen) {
        state.compose = null;
        state.stash = null;
        emit();
      }
      return saved;
    },

    /** Show the saved drafts in place of the inbox (and refresh them). */
    async drafts(args, { state, emit }) {
      const show = args.show !== false;
      state.showDrafts = show;
      state.cursor = 0;
      state.open = null;
      state.openAccount = null;
      emit();
      if (show) await loadDrafts(state, emit);
      else await loadInbox(state, emit);
      return { drafts: state.drafts.length, showing: show ? "drafts" : "inbox" };
    },

    /** Reopen a saved draft in the composer, by `index` or `id`. */
    async openDraft(args, { state, emit }) {
      if (!state.drafts.length) await loadDrafts(state, emit);
      const i = typeof args.index === "number" ? args.index : state.cursor;
      const d = typeof args.id === "string" ? state.drafts.find((x) => x.id === args.id) : state.drafts[i];
      if (!d) return { error: "no such draft" };
      editDraft(state, d);
      emit();
      return { draft: d.id, subject: d.subject, to: d.to };
    },

    /** Send what the composer holds. What enter on an empty body line does. */
    send(_args, ctx) {
      return doSend(ctx);
    },

    // --- the composer's plumbing --------------------------------------------

    /** A keystroke in a composer field: `{ id: "compose.to", value }`. */
    field(args, { state, emit }) {
      const c = state.compose;
      if (c) {
        const name = fieldOf(args.id) as ComposeField;
        if (!FIELDS.includes(name)) return { error: `no such field: ${name}` };
        const value = typeof args.value === "string" ? args.value : "";
        // The body field holds the LINE being typed; it joins the body on enter
        // (see `form`). Keeping it in state means tab or esc can't eat it.
        if (name === "body") c.pending = value;
        else c.values[name] = value;
        c.field = name;
        emit();
        return { field: name };
      }
      if (state.prompt) {
        state.prompt.value = typeof args.value === "string" ? args.value : "";
        emit();
        return { field: "label" };
      }
      return { error: "nothing is being edited" };
    },

    /** Tab: the next field of the composer, keeping a half-typed body line. */
    next(_args, { state, emit }) {
      const c = state.compose;
      if (!c) return;
      if (c.field === "body") commitLine(c, c.pending);
      c.field = FIELDS[(FIELDS.indexOf(c.field) + 1) % FIELDS.length]!;
      emit();
    },

    /**
     * Enter in a composer field. On To/Cc/Subject it moves on; on the body it
     * commits the line you just typed — and an enter on an EMPTY body line is
     * how you say "that's the message", so it sends.
     */
    async form(args, ctx) {
      const { state, emit } = ctx;
      const c = state.compose;
      if (!c) return { error: "no composer open" };
      const name = fieldOf(args.id) as ComposeField;
      const value = typeof args.value === "string" ? args.value : "";
      if (name !== "body") {
        if (FIELDS.includes(name)) c.values[name] = value;
        c.field = FIELDS[Math.min(FIELDS.indexOf(name) + 1, FIELDS.length - 1)] ?? "body";
        emit();
        return { field: c.field };
      }
      if (value.trim()) {
        commitLine(c, value);
        emit();
        return { lines: c.values.body.split("\n").length };
      }
      c.pending = "";
      return doSend(ctx);
    },

    /** Close the composer (or the prompt) without sending. */
    dismiss(_args, ctx) {
      const { state, emit } = ctx;
      if (state.prompt) {
        state.prompt = null;
        emit();
        return { dismissed: "prompt" };
      }
      stash(state);
      state.compose = null;
      emit();
      return { dismissed: "compose" };
    },

    // --- filing -------------------------------------------------------------

    /**
     * Archive: out of the inbox, still in the mailbox. The row goes the moment
     * you press the key and comes back if the provider says no.
     */
    async archive(args, { state, emit }) {
      const hit = target(state, args);
      if (!hit) return { error: "no thread to archive" };
      const row = state.threads.find((t) => t.id === hit.id);
      const wasOpen = state.open?.id === hit.id ? state.open : null;
      removeRow(state, hit.id);
      say(state, `archived: ${truncate(row?.subject ?? hit.id, 44)}`);
      emit();
      try {
        await archiveThread(hit.account, hit.id);
        return { archived: hit.id, account: hit.account };
      } catch (e) {
        if (row) state.threads = mergeThreads([...state.threads, row]);
        if (wasOpen) {
          state.open = wasOpen;
          state.openAccount = hit.account;
        }
        emit();
        return writeFailed(state, e, "archive", providerOf(state, hit.account));
      }
    },

    /** Trash: recoverable from the provider's Trash / Deleted Items. */
    async trash(args, { state, emit }) {
      const hit = target(state, args);
      if (!hit) return { error: "no thread to trash" };
      const row = state.threads.find((t) => t.id === hit.id);
      const wasOpen = state.open?.id === hit.id ? state.open : null;
      removeRow(state, hit.id);
      say(state, `trashed: ${truncate(row?.subject ?? hit.id, 44)}`);
      emit();
      try {
        await trashThread(hit.account, hit.id);
        return { trashed: hit.id, account: hit.account };
      } catch (e) {
        if (row) state.threads = mergeThreads([...state.threads, row]);
        if (wasOpen) {
          state.open = wasOpen;
          state.openAccount = hit.account;
        }
        emit();
        return writeFailed(state, e, "trash", providerOf(state, hit.account));
      }
    },

    /**
     * Label (Gmail) / category (Outlook). With a `name` it applies; without one
     * it asks for the name in a one-field prompt — same verb, both callers.
     */
    async label(args, { state, emit }) {
      const hit = target(state, args);
      if (!hit) return { error: "no thread to label" };
      const name = argText(args, "name", "label", "value", "q");
      if (!name) {
        state.prompt = { kind: "label", value: "", account: hit.account, id: hit.id };
        emit();
        return { dialog: "label" };
      }
      state.prompt = null;
      emit();
      try {
        await labelThread(hit.account, hit.id, name);
        say(state, `labelled “${name}”`);
        emit();
        return { labelled: hit.id, name, account: hit.account };
      } catch (e) {
        return writeFailed(state, e, "label", providerOf(state, hit.account));
      }
    },

    /** Clear the unread dot. Optimistic: the dot goes now, the API catches up. */
    async markRead(args, ctx) {
      return setRead(ctx, args, true);
    },
    /** Put it back. */
    async markUnread(args, ctx) {
      return setRead(ctx, args, false);
    },
    /** Flip it — what `u` presses on the selected row. */
    async toggleRead(args, ctx) {
      const hit = target(ctx.state, args);
      const row = hit ? ctx.state.threads.find((t) => t.id === hit.id) : null;
      return setRead(ctx, args, !!row?.unread);
    },
  },

  // Load the inbox as soon as the daemon boots (survives --watch restarts).
  init({ state, emit }) {
    void loadInbox(state, emit);
  },

  // Keep the inbox fresh while idle; also recovers if you sign in later.
  tickMs: 60_000,
  tick({ state, emit }) {
    if (state.notice && Date.now() - state.noticeAt > NOTICE_MS) {
      state.notice = null;
      emit();
    }
    if (state.loading || state.open || state.compose || state.prompt || state.showDrafts) return;
    void loadInbox(state, emit);
  },

  // Navigation is handled by the platform (arrows + vim). Only the non-nav
  // actions live in the keymap — and a thread you have open answers enter with
  // a reply, because there is nothing left to open.
  keymap: {
    r: { verb: "refresh", label: "refresh" },
    a: { verb: "cycleAccount", label: "account", when: (s) => s.accounts.length > 1 },
    n: { verb: "compose", label: "write" },
    s: { verb: "drafts", label: "drafts", when: (s) => !s.showDrafts },
    return: { verb: "reply", label: "reply", when: (s) => !!s.open },
    g: { verb: "replyAll", label: "reply all", when: (s) => !!s.open },
    f: { verb: "forward", label: "forward", when: (s) => !!s.open },
    e: { verb: "archive", label: "archive", when: hasTarget },
    d: { verb: "trash", label: "trash", when: hasTarget },
    u: { verb: "toggleRead", label: "read/unread", when: hasTarget },
    t: { verb: "label", label: "label", when: hasTarget },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "open",
    back: "back",
    backLabel: "list",
    canBack: (s) => !!s.open || s.showDrafts || !!s.compose,
  },

  // Gmail search syntax works here; the Outlook provider translates the same
  // query into Graph's $search/$filter (from:, subject:, is:unread, has:attachment).
  search: { verb: "search", placeholder: "mail query (e.g. from:doordash, is:unread)" },

  paginate: {
    more: "more",
    hasMore: (s) => !s.showDrafts && Object.keys(s.cursors).length > 0,
    atEnd: (s) => s.cursor >= s.threads.length - 1,
    count: (s) => s.threads.length,
  },

  crumb: (s) =>
    s.compose
      ? COMPOSE_TITLE[s.compose.mode]
      : s.showDrafts
        ? "drafts"
        : s.open
          ? truncate(s.open.subject, 40)
          : s.filter
            ? accountBadge(s.filter)
            : null,

  accent(state) {
    const { ACCENT, AMBER, RED } = palette();
    if (state.error && !state.authed) return AMBER;
    if (state.error) return RED;
    return ACCENT;
  },

  /**
   * The composer, and the one-field prompt a label asks for. Both are real
   * `input` nodes: enter belongs to the field, tab moves between them, ctrl+s
   * parks a draft, esc closes (and keeps what you typed).
   */
  overlay: (state) => {
    const { ACCENT, DIM } = palette();
    if (state.prompt) {
      return {
        node: modal(
          "label",
          [
            labelled(
              "name",
              input("label.name", state.prompt.value, {
                placeholder: "todo, receipts, waiting…",
                width: 30,
                focus: true,
                submit: "label",
                submitLabel: "apply",
                cancel: "dismiss",
                change: "field",
                color: ACCENT,
              }),
              { labelWidth: 5 },
            ),
          ],
          { width: 46, color: ACCENT, footer: "a new name is created on the spot" },
        ),
        scrim: true,
        dismiss: "dismiss",
      };
    }

    const c = state.compose;
    if (!c) return null;
    const line = (id: ComposeField, placeholder: string): ViewNode =>
      input(`compose.${id}`, c.values[id], {
        placeholder,
        width: 46,
        focus: c.field === id,
        submit: "form",
        submitLabel: "next",
        cancel: "dismiss",
        change: "field",
        color: ACCENT,
      });

    // The body is written a line at a time: what you type is the current line,
    // enter commits it, and an enter on an empty line sends. The committed
    // lines sit above the field so you can see the message you are writing.
    const written = c.values.body ? c.values.body.split("\n").slice(-8) : [];
    const body: ViewNode[] = [
      labelled("to     ", line("to", "ada@x.com, grace@y.com"), { labelWidth: 7 }),
      labelled("cc     ", line("cc", "(optional)"), { labelWidth: 7 }),
      labelled("subject", line("subject", "what it's about"), { labelWidth: 7 }),
      divider(54),
      ...written.map((l) => text(l || " ", { color: DIM })),
      input(`compose.body#${c.line}`, c.pending, {
        placeholder: c.values.body ? "…keep typing, empty line sends" : "your message",
        width: 54,
        focus: c.field === "body",
        submit: "form",
        submitLabel: c.values.body ? "line" : "send",
        cancel: "dismiss",
        change: "field",
        color: ACCENT,
      }),
    ];

    return {
      node: modal(COMPOSE_TITLE[c.mode], body, {
        width: 64,
        color: ACCENT,
        footer: c.sending
          ? "sending…"
          : `from ${accountBadge(c.account)}  ·  enter on an empty line sends`,
      }),
      scrim: true,
      dismiss: "dismiss",
      keymap: {
        tab: { verb: "next", label: "next field" },
        "ctrl+s": { verb: "draft", args: { keepOpen: true }, label: "save draft" },
      },
    };
  },

  /**
   * Unread mail, and who the newest one is from. A read inbox says nothing —
   * "0 unread" is not news.
   */
  dash: (s) => {
    if (!s.authed) return null;
    const unread = s.threads.filter((t) => t.unread);
    if (!unread.length) return null;
    const top = unread[0]!;
    return {
      priority: 50,
      text: `✉ ${unread.length} unread  ·  ${top.from}: ${top.subject}`,
      note: shortDate(top.ts, top.date),
      color: palette().UNREAD,
    };
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, (ctx?.width ?? 80)); // usable inner width
    const { ACCENT, FG, DIM, AMBER, UNREAD } = palette();

    if (!state.authed && !state.loading && state.threads.length === 0) {
      return [
        col(
          [
            text("No mail account connected", { color: AMBER }),
            spacer(),
            text("Run  kona login gmail  or  kona login outlook.", { dim: true }),
            text("Connect several and they merge into one inbox.", { dim: true }),
            ...(state.error ? [spacer(), text(truncate(state.error, 60), { color: DIM })] : []),
          ],
          { align: "start" },
        ),
      ];
    }

    // A write refused for want of a scope is worth more than a toast: it needs
    // one command from you, and until it is run every write will fail.
    const banner: ViewNode[] = state.notice
      ? [toast(state.notice, /couldn't|reconnect/.test(state.notice) ? "warn" : "info", { width: W - 1 })]
      : state.scopeNeeded
        ? [toast(`${state.scopeNeeded}: ${scopeHint(state.scopeNeeded)}`, "warn", { width: W - 1 })]
        : [];

    // Reading one thread
    if (state.open) {
      const t = state.open;
      const head = state.openAccount && state.accounts.length > 1
        ? `${truncate(t.subject, W - 14)}   [${accountBadge(state.openAccount)}]`
        : truncate(t.subject, W - 2);
      const body: ViewNode[] = [...banner, text(head, { color: ACCENT }), divider(W - 1)];
      for (const m of t.messages) {
        body.push(keyValue("from", truncate(m.from, W - 8), { color: FG }));
        body.push(text(m.date, { dim: true }));
        body.push(spacer());
        // Keep whole lines (they word-wrap in the host); cap total for now.
        for (const line of m.body.split("\n").slice(0, 60)) body.push(text(line || " ", { color: FG }));
        body.push(spacer());
      }
      return [col(body)];
    }

    // Saved drafts, in place of the inbox
    if (state.showDrafts) {
      const rows: ViewNode[] = state.drafts.map((d, i) =>
        recordRow(
          [
            { text: "✎", width: 1 },
            { text: d.to.join(", ") || "(no recipient)", width: Math.min(26, Math.max(14, Math.floor(W * 0.24))) },
            { text: d.subject || "(no subject)", grow: true },
            { text: shortDate(d.ts), width: 8, align: "right" as const },
          ],
          { width: W, selected: i === state.cursor, accent: ACCENT, color: FG, index: i },
        ),
      );
      if (!rows.length) {
        rows.push(text(state.loading ? "loading…" : "(no saved drafts — press n to write one)", { dim: true }));
      }
      return [
        col([
          ...banner,
          text(`drafts   ${state.drafts.length} saved`, { dim: true }),
          divider(W - 1),
          ...rows,
        ]),
      ];
    }

    // The inbox list
    const multi = state.accounts.length > 1;
    const scope = state.filter ? accountBadge(state.filter) : multi ? `${state.accounts.length} accounts` : "";
    const loaded = `${state.threads.length}${Object.keys(state.cursors).length ? "+" : ""} loaded`;
    const header = state.loading
      ? text("syncing…", { color: AMBER })
      : text([state.query, scope, loaded].filter(Boolean).join("   "), { dim: true });

    // Each thread is a record row: unread dot · sender · subject (grows) ·
    // account badge (only worth a column when more than one is connected) · date.
    const fromW = Math.min(26, Math.max(14, Math.floor(W * 0.24)));
    const rows: ViewNode[] = state.threads.map((t, i) =>
      recordRow(
        [
          { text: t.unread ? "●" : " ", width: 1 },
          { text: t.from, width: fromW },
          { text: t.subject, grow: true },
          ...(multi && !state.filter ? [{ text: accountBadge(t.account), width: 10 }] : []),
          { text: shortDate(t.ts, t.date), width: 8, align: "right" as const },
        ],
        {
          width: W,
          selected: i === state.cursor,
          accent: ACCENT,
          color: t.unread ? UNREAD : FG,
          index: i,
        },
      ),
    );

    if (rows.length === 0 && !state.loading) {
      rows.push(text("(empty — press r to refresh)", { dim: true }));
    }
    if (Object.keys(state.cursors).length) rows.push(text("  ↓ more…", { dim: true }));

    return [col([...banner, header, divider(W - 1), ...rows])];
  },
});

/** The composer's title, which is also the breadcrumb. */
const COMPOSE_TITLE: Record<ComposeMode, string> = {
  new: "new message",
  reply: "reply",
  replyAll: "reply all",
  forward: "forward",
  draft: "draft",
};

/** True when a filing key has something to act on (a row, or an open thread). */
function hasTarget(s: EmailState): boolean {
  return !s.showDrafts && (!!s.open || s.threads.length > 0);
}

/**
 * Mark read/unread, optimistically: the dot flips in state and emits before
 * the provider is asked, and flips back if the provider refuses. Shared by
 * markRead / markUnread / toggleRead, which differ only in the flag.
 */
async function setRead(
  { state, emit }: Ctx,
  args: Record<string, unknown>,
  read: boolean,
): Promise<Record<string, unknown>> {
  const hit = target(state, args);
  if (!hit) return { error: "no thread to mark" };
  const row = state.threads.find((t) => t.id === hit.id);
  const before = row?.unread;
  if (row) {
    row.unread = !read;
    emit();
  }
  try {
    await providerMarkRead(hit.account, hit.id, read);
    return { id: hit.id, account: hit.account, unread: !read };
  } catch (e) {
    if (row && before !== undefined) row.unread = before;
    emit();
    return writeFailed(state, e, read ? "mark it read" : "mark it unread", providerOf(state, hit.account));
  }
}
