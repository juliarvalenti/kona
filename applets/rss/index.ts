import { defineApplet, text, spacer, col, type ViewNode } from "../../sdk/index.ts";
import { keyValue, divider, recordRow } from "../../sdk/components.ts";
import { readFeeds, fetchRiver, matches, CONFIG_FILE, type FeedItem, type FeedError } from "../../server/rss.ts";

/**
 * rss — your feeds as one river, browsed like mail: a list you walk with j/k,
 * `→` to drill into the reader, `←` back. The daemon does the fetching and
 * parsing, so an AGENT can call the same verbs (refresh, search, open) with no
 * window open — and the human's list repaints when it does.
 */

interface RssState {
  items: FeedItem[];
  cursor: number;
  query: string;
  open: FeedItem | null;
  /** Item ids read this session — drives the unread dot. */
  read: string[];
  /** How many rows of the river are materialized (grows via `more`). */
  limit: number;
  loading: boolean;
  error: string | null;
  feedErrors: FeedError[];
  feeds: number;
  configured: boolean;
  syncedAt: number;
}

const ACCENT = "#f26522"; // feed-icon orange
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const AMBER = "#f0b000";
const RED = "#ff5c57";
const UNREAD = "#00d488";

const PAGE = 25;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Epoch ms -> "4m" / "3h" / "2d". Empty when the feed gave no date. */
function ago(ms: number): string {
  if (!ms) return "";
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 365 ? `${d}d` : `${Math.round(d / 365)}y`;
}

/** The rows actually on screen: the query filter, capped by the page limit. */
function visible(state: RssState): FeedItem[] {
  return state.items.filter((it) => matches(it, state.query)).slice(0, state.limit);
}

/** Fetch every configured feed and merge into the river. */
async function load(state: RssState, emit: () => void) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  emit();
  try {
    const feeds = await readFeeds();
    state.feeds = feeds.length;
    state.configured = feeds.length > 0;
    if (!state.configured) return;
    const river = await fetchRiver(feeds);
    state.items = river.items;
    state.feedErrors = river.errors;
    state.cursor = Math.min(state.cursor, Math.max(0, visible(state).length - 1));
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    state.syncedAt = Date.now();
    emit();
  }
}

export default defineApplet<RssState>({
  id: "rss",
  title: "RSS",
  summary: "Your feeds as one river. Agents can search and open items too.",
  ephemeral: true, // the river is re-fetched on boot — nothing to persist
  initialState: {
    items: [],
    cursor: 0,
    query: "",
    open: null,
    read: [],
    limit: PAGE,
    loading: false,
    error: null,
    feedErrors: [],
    feeds: 0,
    configured: false,
    syncedAt: 0,
  },

  docs: {
    refresh: "Refetch every feed and rebuild the river.",
    search: { doc: "Filter the river locally — no refetch, so it is instant.", args: { q: "bun" } },
    more: "Show the next page of items.",
    open: { doc: "Open an item by `index` and read its text.", args: { index: 0 } },
    browser: "Hand the open (or selected) item to a browser.",
  },

  verbs: {
    async refresh(_args, { state, emit }) {
      await load(state, emit);
      return { count: state.items.length, feeds: state.feeds, errors: state.feedErrors };
    },
    /** Filter the river locally — no refetch, so it is instant. */
    search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.open = null;
      state.cursor = 0;
      state.limit = PAGE;
      emit();
      return { query: state.query, count: visible(state).length };
    },
    more(_args, { state, emit }) {
      state.limit += PAGE;
      emit();
      return { shown: visible(state).length };
    },
    open(args, { state, emit }) {
      const rows = visible(state);
      const idx = typeof args.index === "number" ? args.index : state.cursor;
      const item = rows[idx];
      if (!item) return { error: "no such item" };
      state.cursor = idx;
      state.open = item;
      if (!state.read.includes(item.id)) state.read = [...state.read, item.id];
      emit();
      return { title: item.title, feed: item.feed, link: item.link };
    },
    /** Hand the open (or selected) item to the browser. */
    browser(_args, { state }) {
      const item = state.open ?? visible(state)[state.cursor];
      if (!item?.link) return { error: "no link" };
      try {
        Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", item.link]);
      } catch {
        return { error: "no browser opener found", link: item.link };
      }
      return { opened: item.link };
    },
    back(_args, { state, emit }) {
      state.open = null;
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(Math.max(0, visible(state).length - 1), state.cursor + 1);
      emit();
    },
    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
  },

  // Fetch on daemon boot so the river is warm before anyone opens the applet.
  init({ state, emit }) {
    void load(state, emit);
  },

  // Feeds move slowly; poll every 5 minutes and never while you're reading.
  tickMs: 300_000,
  tick({ state, emit }) {
    if (!state.loading && !state.open) void load(state, emit);
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
    o: { verb: "browser", label: "browser" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "read",
    back: "back",
    backLabel: "list",
    canBack: (s) => !!s.open,
  },

  search: { verb: "search", placeholder: "filter items (title, feed, author, text)…" },

  paginate: {
    more: "more",
    hasMore: (s) => s.items.filter((it) => matches(it, s.query)).length > s.limit,
    atEnd: (s) => s.cursor >= visible(s).length - 1,
    count: (s) => visible(s).length,
  },

  crumb: (s) => (s.open ? truncate(s.open.title, 40) : null),

  accent(state) {
    if (!state.configured) return AMBER;
    if (state.error) return RED;
    return ACCENT;
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);

    // No feeds yet — show exactly what to write, and where.
    if (!state.configured && !state.loading) {
      return [
        col(
          [
            text("No feeds configured", { color: AMBER }),
            spacer(),
            text(`Add some to  ${CONFIG_FILE}`, { dim: true }),
            spacer(),
            text('feeds = ["https://news.ycombinator.com/rss"]', { color: FG }),
            spacer(),
            text("[[feeds]]", { color: FG }),
            text('name = "xkcd"', { color: FG }),
            text('url  = "https://xkcd.com/atom.xml"', { color: FG }),
            ...(state.error ? [spacer(), text(truncate(state.error, W - 4), { color: RED })] : []),
          ],
          { align: "start" },
        ),
      ];
    }

    // Reading one item.
    if (state.open) {
      const it = state.open;
      const when = it.published ? new Date(it.published).toLocaleString() : "";
      const body: ViewNode[] = [
        text(truncate(it.title, W - 2), { color: ACCENT }),
        keyValue("from", truncate([it.feed, it.author].filter(Boolean).join("  ·  "), W - 8), { color: FG }),
        ...(when ? [text(when, { dim: true })] : []),
        ...(it.link ? [text(truncate(it.link, W - 2), { dim: true })] : []),
        divider(W - 1),
      ];
      const lines = it.summary ? it.summary.split("\n").slice(0, 200) : ["(no content — press o to open in a browser)"];
      for (const line of lines) body.push(text(line || " ", { color: it.summary ? FG : DIM }));
      return [col(body)];
    }

    // The river.
    const rows = visible(state);
    const total = state.items.filter((it) => matches(it, state.query)).length;
    const label = `${state.query ? `“${state.query}”   ` : ""}${rows.length}/${total} items · ${state.feeds} feeds`;
    const header = state.loading ? text("fetching…", { color: AMBER }) : text(label, { dim: true });

    const feedW = Math.min(20, Math.max(10, Math.floor(W * 0.2)));
    const nodes: ViewNode[] = rows.map((it, i) =>
      recordRow(
        [
          { text: state.read.includes(it.id) ? " " : "●", width: 1 },
          { text: it.feed, width: feedW },
          { text: it.title, grow: true },
          { text: ago(it.published), width: 5, align: "right" },
        ],
        {
          width: W,
          selected: i === state.cursor,
          accent: ACCENT,
          color: state.read.includes(it.id) ? FG : UNREAD,
        },
      ),
    );

    if (!rows.length && !state.loading) {
      nodes.push(text(state.query ? "no matches" : "(empty — press r to refresh)", { dim: true }));
    }
    if (total > rows.length) nodes.push(text("  ↓ more…", { dim: true }));
    for (const e of state.feedErrors) nodes.push(text(`! ${e.feed}: ${truncate(e.message, 40)}`, { color: AMBER }));
    if (state.error) nodes.push(text(truncate(state.error, W - 4), { color: RED }));

    return [col([header, divider(W - 1), ...nodes])];
  },
});
