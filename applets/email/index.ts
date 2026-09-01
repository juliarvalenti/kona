import { defineApplet, text, spacer, col, theme, appletAccent, appletNumber, type ViewNode } from "../../sdk/index.ts";
import { keyValue, divider, recordRow } from "../../sdk/components.ts";
import {
  listInbox,
  getThread,
  listAccounts,
  findAccount,
  threadKey,
  type Account,
  type OpenThread,
  type UnifiedThread,
} from "../../server/mail.ts";
import { notify, freshIds } from "../../server/notify.ts";

/** Threads per fetch, per account. `[applets.email] page = 50` raises it. */
const PAGE = Math.max(1, Math.min(100, Math.round(appletNumber("email", "page", 20))));

/**
 * email — browse your mail in the terminal, across providers. The daemon owns
 * the OAuth tokens and talks to every connected mailbox through the
 * `MailProvider` seam in server/mail.ts (Gmail today, Outlook too), so YOU
 * browse the merged list with j/k/l and an AGENT can call the same verbs
 * (refresh, search, open, account) headlessly. Read-only.
 *
 * Several accounts at once are the normal case: rows from every mailbox are
 * merged newest-first and tagged with a badge, `account` scopes the list to
 * one, and every row carries the account it came from so opening it routes back
 * to the right provider.
 */

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
}

/** Every color is a theme role; `[applets.email] accent` retints the frame. */
const palette = () => {
  const t = theme();
  return { ACCENT: appletAccent("email", t.accent), FG: t.fg, DIM: t.dim, AMBER: t.warn, RED: t.error, UNREAD: t.ok };
};

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

export default defineApplet<EmailState>({
  id: "email",
  title: "Email",
  summary: "Browse Gmail and Outlook in one list. Agents can search and open threads too.",
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
  },

  docs: {
    refresh: "Reload the inbox. Call this before you read state.",
    search: { doc: "Run a Gmail query and replace the list with its results.", args: { q: "is:unread newer_than:1d" } },
    more: "Fetch the next page of threads.",
    open: { doc: "Open a thread by list `index` and load its body.", args: { index: 0 } },
  },

  recipes: [
    {
      title: "Triage the inbox",
      steps: [
        `kona call email refresh`,
        `kona call email search '{"q":"is:unread newer_than:1d"}'   # -> { count: 12 }`,
        `kona state email                                            # threads[]: from, subject, snippet`,
        `kona call email open '{"index":0}'                          # -> the body, for summarising`,
      ],
      note: "The Gmail scope is read-only: kona reads and shows mail, it never sends or archives. Triage means reading, summarising, and telling the human what deserves a reply.",
    },
  ],

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadInbox(state, emit);
      return { count: state.threads.length, authed: state.authed, accounts: state.accounts.map((a) => a.id) };
    },
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "in:inbox");
      state.open = null;
      state.openAccount = null;
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
    // whatever the cursor is on.
    async open(args, { state, emit }) {
      let account = typeof args.account === "string" ? args.account : null;
      let id = typeof args.id === "string" ? args.id : null;
      if (!id) {
        const idx = typeof args.index === "number" ? args.index : state.cursor;
        const target = state.threads[idx];
        if (!target) return { error: "no such thread" };
        state.cursor = idx;
        account = target.account;
        id = target.id;
      }
      account ??= state.threads.find((t) => t.id === id)?.account ?? state.filter ?? state.accounts[0]?.id ?? "";
      state.loading = true;
      emit();
      try {
        state.open = await getThread(account, id);
        state.openAccount = account;
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { subject: state.open?.subject, account };
    },
    back(_args, { state, emit }) {
      state.open = null;
      state.openAccount = null;
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(state.threads.length - 1, state.cursor + 1);
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
  },

  // Load the inbox as soon as the daemon boots (survives --watch restarts).
  init({ state, emit }) {
    void loadInbox(state, emit);
  },

  // Keep the inbox fresh while idle; also recovers if you sign in later.
  tickMs: 60_000,
  tick({ state, emit }) {
    if (!state.loading && !state.open) void loadInbox(state, emit);
  },

  // Navigation is handled by the platform (arrows + vim). Only the non-nav
  // actions live in the keymap.
  keymap: {
    r: { verb: "refresh", label: "refresh" },
    a: { verb: "cycleAccount", label: "account" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "open",
    back: "back",
    backLabel: "list",
    canBack: (s) => !!s.open,
  },

  // Gmail search syntax works here; the Outlook provider translates the same
  // query into Graph's $search/$filter (from:, subject:, is:unread, has:attachment).
  search: { verb: "search", placeholder: "mail query (e.g. from:doordash, is:unread)" },

  paginate: {
    more: "more",
    hasMore: (s) => Object.keys(s.cursors).length > 0,
    atEnd: (s) => s.cursor >= s.threads.length - 1,
    count: (s) => s.threads.length,
  },

  crumb: (s) => (s.open ? truncate(s.open.subject, 40) : s.filter ? accountBadge(s.filter) : null),

  accent(state) {
    const { ACCENT, AMBER, RED } = palette();
    if (state.error && !state.authed) return AMBER;
    if (state.error) return RED;
    return ACCENT;
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
            text("Run  kona login gmail  or  kona login outlook  (read-only).", { dim: true }),
            text("Connect several and they merge into one inbox.", { dim: true }),
            ...(state.error ? [spacer(), text(truncate(state.error, 60), { color: DIM })] : []),
          ],
          { align: "start" },
        ),
      ];
    }

    // Reading one thread
    if (state.open) {
      const t = state.open;
      const head = state.openAccount && state.accounts.length > 1
        ? `${truncate(t.subject, W - 14)}   [${accountBadge(state.openAccount)}]`
        : truncate(t.subject, W - 2);
      const body: ViewNode[] = [text(head, { color: ACCENT }), divider(W - 1)];
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

    return [col([header, divider(W - 1), ...rows])];
  },
});
