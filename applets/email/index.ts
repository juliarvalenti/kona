import { defineApplet, text, spacer, col, type ViewNode } from "../../sdk/index.ts";
import { keyValue, divider } from "../../sdk/components.ts";
import { listInbox, getThread, type MailThread, type OpenThread } from "../../server/gmail.ts";

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
}

const ACCENT = "#7aa2f7";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const AMBER = "#f0b000";
const RED = "#ff5c57";
const UNREAD = "#00d488";

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
function pad(s: string, n: number): string {
  return truncate(s, n).padEnd(n);
}

/** Shared inbox loader used by the refresh/search verbs and the auto-refresh tick. */
async function loadInbox(state: EmailState, emit: () => void) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  emit();
  try {
    state.threads = await listInbox(state.query, 20);
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
  },

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadInbox(state, emit);
      return { count: state.threads.length, authed: state.authed };
    },
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "in:inbox");
      state.open = null;
      await loadInbox(state, emit);
      return { query: state.query, count: state.threads.length };
    },
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

  crumb: (s) => (s.open ? truncate(s.open.subject, 40) : null),

  accent(state) {
    if (state.error && !state.authed) return AMBER;
    if (state.error) return RED;
    return ACCENT;
  },

  view(state): ViewNode[] {
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
      const body: ViewNode[] = [text(truncate(t.subject, 56), { color: ACCENT }), divider(56)];
      for (const m of t.messages) {
        body.push(keyValue("from", truncate(m.from, 40), { color: FG }));
        body.push(text(m.date, { dim: true }));
        body.push(spacer());
        // Keep whole lines (they word-wrap in the host); cap total for now.
        for (const line of m.body.split("\n").slice(0, 60)) body.push(text(line || " ", { color: FG }));
        body.push(spacer());
      }
      return [col(body)];
    }

    // The inbox list
    const header = state.loading
      ? text("syncing…", { color: AMBER })
      : text(`${state.query}   ${state.threads.length} threads`, { dim: true });

    const rows: ViewNode[] = state.threads.map((t, i) => {
      const sel = i === state.cursor;
      const marker = sel ? "▸" : " ";
      const dot = t.unread ? "●" : " ";
      const line = `${marker} ${dot} ${pad(t.from, 16)}  ${truncate(t.subject, 34)}`;
      return text(line, { color: sel ? ACCENT : t.unread ? UNREAD : FG, dim: !sel && !t.unread });
    });

    if (rows.length === 0 && !state.loading) {
      rows.push(text("(empty — press r to refresh)", { dim: true }));
    }

    return [col([header, divider(56), ...rows])];
  },
});
