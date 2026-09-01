import { defineApplet, text, spacer, col, theme, appletAccent, appletNumber, type ViewNode } from "../../sdk/index.ts";
import { keyValue, divider, recordRow } from "../../sdk/components.ts";
import { listInbox, getThread, type MailThread, type OpenThread } from "../../server/gmail.ts";

/** Threads per fetch. `[applets.email] page = 50` in config.toml raises it. */
const PAGE = Math.max(1, Math.min(100, Math.round(appletNumber("email", "page", 20))));

/**
 * email — browse Gmail in the terminal. The daemon owns the OAuth tokens and
 * fetches over the Gmail REST API, so YOU browse the list with j/k/l and an
 * AGENT can call the same verbs (refresh, search, open) headlessly. Read-only.
 */

interface EmailState {
  threads: MailThread[];
  cursor: number;
  query: string;
  open: OpenThread | null;
  loading: boolean;
  error: string | null;
  authed: boolean;
  syncedAt: number;
  nextPage: string | null; // Gmail page cursor; null = no more
}

/** Every color is a theme role; `[applets.email] accent` retints the frame. */
const palette = () => {
  const t = theme();
  return { ACCENT: appletAccent("email", t.accent), FG: t.fg, DIM: t.dim, AMBER: t.warn, RED: t.error, UNREAD: t.ok };
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** RFC-2822 date header -> "31 Aug" (compact for the list). */
function shortDate(d: string): string {
  const m = d.match(/(\d{1,2})\s+([A-Z][a-z]{2})/);
  return m ? `${m[1]} ${m[2]}` : d.slice(0, 12);
}
function pad(s: string, n: number): string {
  return truncate(s, n).padEnd(n);
}

/** (Re)load the first page. Used by refresh/search and the auto-refresh tick. */
async function loadInbox(state: EmailState, emit: () => void) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  emit();
  try {
    const page = await listInbox(state.query, PAGE);
    state.threads = page.threads;
    state.nextPage = page.nextPageToken ?? null;
    state.cursor = Math.min(state.cursor, Math.max(0, state.threads.length - 1));
    state.authed = true;
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

/** Append the next page (infinite scroll). */
async function loadMore(state: EmailState, emit: () => void) {
  if (state.loading || !state.nextPage) return;
  state.loading = true;
  emit();
  try {
    const page = await listInbox(state.query, PAGE, state.nextPage);
    state.threads = [...state.threads, ...page.threads];
    state.nextPage = page.nextPageToken ?? null;
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
  summary: "Browse Gmail. Agents can search and open threads too.",
  ephemeral: true, // mail lives in RAM only — never written to state.json
  initialState: {
    threads: [],
    cursor: 0,
    query: "in:inbox",
    open: null,
    loading: false,
    error: null,
    authed: false,
    syncedAt: 0,
    nextPage: null,
  },

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadInbox(state, emit);
      return { count: state.threads.length, authed: state.authed };
    },
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "in:inbox");
      state.open = null;
      state.cursor = 0;
      await loadInbox(state, emit);
      return { query: state.query, count: state.threads.length };
    },
    async more(_args, { state, emit }) {
      await loadMore(state, emit);
      return { count: state.threads.length, hasMore: !!state.nextPage };
    },
    // index selects a specific thread (an agent's call, or a mouse click on a
    // row); without one, open whatever the cursor is on.
    async open(args, { state, emit }) {
      const idx = typeof args.index === "number" ? args.index : state.cursor;
      const target = state.threads[idx];
      if (!target) return { error: "no such thread" };
      state.cursor = idx;
      state.loading = true;
      emit();
      try {
        state.open = await getThread(target.id);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { subject: state.open?.subject };
    },
    back(_args, { state, emit }) {
      state.open = null;
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
  // action lives in the keymap.
  keymap: {
    r: { verb: "refresh", label: "refresh" },
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

  // Gmail search syntax works here: from:, subject:, is:unread, has:attachment…
  search: { verb: "search", placeholder: "gmail query (e.g. from:doordash, is:unread)" },

  paginate: {
    more: "more",
    hasMore: (s) => !!s.nextPage,
    atEnd: (s) => s.cursor >= s.threads.length - 1,
    count: (s) => s.threads.length,
  },

  crumb: (s) => (s.open ? truncate(s.open.subject, 40) : null),

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
            text("Not signed in to Gmail", { color: AMBER }),
            spacer(),
            text("Run  kona login  to connect your account (read-only).", { dim: true }),
            ...(state.error ? [spacer(), text(truncate(state.error, 60), { color: DIM })] : []),
          ],
          { align: "start" },
        ),
      ];
    }

    // Reading one thread
    if (state.open) {
      const t = state.open;
      const body: ViewNode[] = [text(truncate(t.subject, W - 2), { color: ACCENT }), divider(W - 1)];
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
    const loaded = `${state.threads.length}${state.nextPage ? "+" : ""} loaded`;
    const header = state.loading
      ? text("syncing…", { color: AMBER })
      : text(`${state.query}   ${loaded}`, { dim: true });

    // Each thread is a record row: unread dot · sender · subject (grows) · date.
    const fromW = Math.min(26, Math.max(14, Math.floor(W * 0.24)));
    const rows: ViewNode[] = state.threads.map((t, i) =>
      recordRow(
        [
          { text: t.unread ? "●" : " ", width: 1 },
          { text: t.from, width: fromW },
          { text: t.subject, grow: true },
          { text: shortDate(t.date), width: 12, align: "right" },
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
    if (state.nextPage) rows.push(text("  ↓ more…", { dim: true }));

    return [col([header, divider(W - 1), ...rows])];
  },
});
