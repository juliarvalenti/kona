import { defineApplet, text, spacer, col, row, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow, keyValue, sparkText } from "../../sdk/components.ts";
import {
  quotes as fetchQuotes,
  watchlist as configuredWatchlist,
  normalizeSymbol,
  dedupe,
  webUrl,
  type Quote,
} from "../../server/ticker.ts";

/**
 * ticker — a watchlist board for stocks and crypto.
 *
 * The daemon polls a keyless public endpoint on its own schedule, so the board
 * is warm whether or not anyone is looking: YOU press `/` to add a symbol and
 * `r` to refresh, an AGENT calls `ticker.add {"symbol":"NVDA"}` or reads
 * `ticker.state` to answer "how's my portfolio doing" — same watchlist, same
 * quotes, same state.
 */

interface TickerState {
  symbols: string[];
  quotes: Quote[];
  cursor: number;
  /** Symbol of the open detail screen, or null for the board. */
  open: string | null;
  loading: boolean;
  error: string | null;
  /** ms epoch of the last successful poll (0 = never). */
  updatedAt: number;
}

const UP = "#00d488";
const DOWN = "#ff5c57";
const FLAT = "#8a8a8a";
const FG = "#d0d0d0";
const AMBER = "#f0b000";
const DIM = "#6a6a6a";

// Quotes come from a courtesy endpoint, so poll politely: at most every 45s,
// and back off for 5 minutes when the whole fetch fails (rate limit, offline) —
// the same discipline dash applies to GitHub.
const REFRESH_MS = 45_000;
const BACKOFF_MS = 300_000;
let nextFetchAt = 0;
let inFlight = false;

async function refresh(state: TickerState, emit: () => void) {
  if (inFlight || !state.symbols.length) return;
  inFlight = true;
  state.loading = !state.quotes.length; // only show a spinner on a cold board
  emit();
  try {
    state.quotes = await fetchQuotes(state.symbols);
    state.error = null;
    state.updatedAt = Date.now();
    nextFetchAt = Date.now() + REFRESH_MS;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    state.error = /rate limit/i.test(m) ? "rate-limited — backing off" : m;
    nextFetchAt = Date.now() + BACKOFF_MS;
  } finally {
    inFlight = false;
    state.loading = false;
    emit();
  }
}

const quoteOf = (state: TickerState, symbol: string | null): Quote | undefined =>
  symbol ? state.quotes.find((q) => q.symbol === symbol) : undefined;

/** The symbol under the cursor (rows follow `symbols`, not the fetch order). */
function selected(state: TickerState): string | null {
  return state.symbols[Math.min(state.cursor, state.symbols.length - 1)] ?? null;
}

function tint(q: Quote | undefined): string {
  if (!q || q.error) return DIM;
  return q.change > 0 ? UP : q.change < 0 ? DOWN : FLAT;
}

/** Prices span BTC (77,859.73) to a sub-penny coin — scale the decimals. */
function price(n: number, currency = "USD"): string {
  const digits = n === 0 ? 2 : n < 1 ? 6 : n < 100 ? 2 : 2;
  const s = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === "USD" ? s : `${s} ${currency}`;
}

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function compact(n: number): string {
  if (!n) return "—";
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (n >= size) return `${(n / size).toFixed(n / size < 10 ? 1 : 0)}${suffix}`;
  }
  return String(Math.round(n));
}

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default defineApplet<TickerState>({
  id: "ticker",
  title: "Ticker",
  summary: "Watchlist board — stocks and crypto, price, %chg, sparkline.",
  initialState: {
    symbols: [],
    quotes: [],
    cursor: 0,
    open: null,
    loading: false,
    error: null,
    updatedAt: 0,
  },

  docs: {
    refresh: "Poll quotes now, ignoring the every-45s gate.",
    add: { doc: "Add symbols to the watchlist (comma- or space-separated).", args: { symbols: "NVDA, BTC-USD" } },
    remove: { doc: "Drop a symbol.", args: { symbol: "NVDA" } },
    reset: "Re-seed the watchlist from config (env / ~/.config/kona/ticker.json).",
    select: "Open the detail screen for the selected symbol.",
    web: "Open the selected symbol's page in a browser.",
  },

  verbs: {
    /** Poll now, ignoring the every-45s gate (a keypress means "now"). */
    async refresh(_a, { state, emit }) {
      nextFetchAt = 0;
      await refresh(state, emit);
      return { symbols: state.symbols.length, updatedAt: state.updatedAt };
    },

    /**
     * Add one or more symbols. Takes `symbol`, `symbols`, or `q` (the host's
     * search line submits `q`), comma- or space-separated.
     */
    async add(args, { state, emit }) {
      const raw = args.symbol ?? args.symbols ?? args.q ?? "";
      const wanted = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/))
        .map((s) => normalizeSymbol(String(s)))
        .filter((s): s is string => !!s);
      if (!wanted.length) {
        state.error = "not a symbol — try AAPL, SPY, ^GSPC or BTC-USD";
        emit();
        return { added: [] };
      }
      const added = wanted.filter((s) => !state.symbols.includes(s));
      state.symbols = dedupe([...state.symbols, ...wanted]);
      state.cursor = Math.max(0, state.symbols.indexOf(added[0] ?? wanted[0]!));
      state.error = null;
      emit();
      nextFetchAt = 0;
      await refresh(state, emit);
      return { added, watchlist: state.symbols };
    },

    /** Drop a symbol — the one named, else the one under the cursor. */
    remove(args, { state, emit }) {
      const target = args.symbol ? normalizeSymbol(String(args.symbol)) : selected(state);
      if (!target) return { removed: null };
      state.symbols = state.symbols.filter((s) => s !== target);
      state.quotes = state.quotes.filter((q) => q.symbol !== target);
      if (state.open === target) state.open = null;
      state.cursor = Math.min(state.cursor, Math.max(0, state.symbols.length - 1));
      emit();
      return { removed: target, watchlist: state.symbols };
    },

    /** Re-seed the watchlist from config (env / ~/.config/kona/ticker.json). */
    async reset(_a, { state, emit }) {
      state.symbols = await configuredWatchlist();
      state.quotes = [];
      state.cursor = 0;
      state.open = null;
      emit();
      nextFetchAt = 0;
      await refresh(state, emit);
      return { watchlist: state.symbols };
    },

    up(_a, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_a, { state, emit }) {
      state.cursor = Math.min(Math.max(0, state.symbols.length - 1), state.cursor + 1);
      emit();
    },

    /** Open the detail screen for the selected symbol. */
    select(_a, { state, emit }) {
      state.open = selected(state);
      emit();
      return { open: state.open };
    },
    back(_a, { state, emit }) {
      state.open = null;
      emit();
    },

    /** Open the symbol's page in the browser. */
    web(_a, { state }) {
      const symbol = state.open ?? selected(state);
      if (!symbol) return {};
      const url = webUrl(symbol);
      Bun.spawn(["open", url]);
      return { opened: url };
    },
  },

  async init({ state, emit }) {
    // First boot seeds from config; after that the persisted watchlist wins, so
    // symbols you add by hand (or an agent adds) survive a daemon restart.
    if (!state.symbols.length) state.symbols = await configuredWatchlist();
    nextFetchAt = 0;
    void refresh(state, emit);
  },

  // A cheap heartbeat keeps the "updated Ns ago" line honest; the actual fetch
  // is gated to REFRESH_MS (and BACKOFF_MS after a failure).
  tickMs: 15_000,
  tick({ state, emit }) {
    if (Date.now() >= nextFetchAt && !inFlight) {
      nextFetchAt = Date.now() + REFRESH_MS; // tentative; refresh() sets the real time
      void refresh(state, emit);
    } else {
      emit();
    }
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
    x: { verb: "remove", label: "remove" },
    o: { verb: "web", label: "open on web" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "select",
    selectLabel: "detail",
    back: "back",
    backLabel: "back",
    canBack: (s) => !!s.open,
  },

  search: { verb: "add", placeholder: "add a symbol (AAPL, SPY, ^GSPC, BTC-USD)…" },

  crumb: (s) => s.open,

  accent(state) {
    if (state.error) return AMBER;
    const q = quoteOf(state, state.open ?? selected(state));
    return tint(q);
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);

    if (state.open) return [col(detail(state, W))];

    const nodes: ViewNode[] = [];
    const live = state.quotes.filter((q) => !q.error).length;
    nodes.push(
      row([
        text(`MARKETS  ·  ${live}/${state.symbols.length} quoted`, { color: UP }),
        text(`   updated ${ago(state.updatedAt)}`, { dim: true }),
      ]),
      divider(W - 1),
    );

    if (state.error) nodes.push(text(state.error, { color: AMBER }));

    if (!state.symbols.length) {
      nodes.push(
        text("Watchlist empty", { dim: true }),
        spacer(),
        text("Press / to add a symbol, or set ~/.config/kona/ticker.json", { dim: true }),
      );
      return [col(nodes)];
    }

    // One row per symbol, in watchlist order (a quote that hasn't landed yet
    // still gets its row, so the board never reshuffles under the cursor).
    const nameW = Math.min(24, Math.max(8, Math.floor(W * 0.28)));
    const sparkW = W >= 72 ? 12 : 8;
    state.symbols.forEach((symbol, i) => {
      const q = state.quotes.find((x) => x.symbol === symbol);
      const color = tint(q);
      const cells = q?.error
        ? [
            { text: symbol, width: 10 },
            { text: q.error, grow: true },
            { text: "!", width: 8, align: "right" as const },
          ]
        : [
            { text: symbol, width: 10 },
            { text: q?.name ?? "…", grow: true },
            { text: q ? sparkText(q.spark, sparkW) : "", width: sparkW },
            { text: q ? price(q.price, q.currency) : "—", width: 12, align: "right" as const },
            { text: q ? pct(q.changePct) : "", width: 9, align: "right" as const },
          ];
      nodes.push(
        recordRow(cells, { width: W, selected: i === state.cursor, accent: color, color: q ? color : DIM }),
      );
    });

    if (state.loading) nodes.push(spacer(), text("loading quotes…", { color: AMBER }));

    return [col(nodes)];
  },
});

/** The detail screen: one symbol, a wide sparkline, and the day's numbers. */
function detail(state: TickerState, W: number): ViewNode[] {
  const symbol = state.open!;
  const q = state.quotes.find((x) => x.symbol === symbol);
  if (!q) {
    return [text(symbol, { color: FG }), spacer(), text("no quote yet — press r", { dim: true })];
  }
  if (q.error) {
    return [text(symbol, { color: FG }), spacer(), text(q.error, { color: AMBER })];
  }

  const color = tint(q);
  const arrow = q.change > 0 ? "▲" : q.change < 0 ? "▼" : "·";
  return [
    row([text(`${q.symbol}  `, { color }), text(q.name, { dim: true })]),
    text(`${q.kind}${q.open ? "" : "  ·  market closed"}`, { dim: true }),
    spacer(),
    row([
      text(price(q.price, q.currency), { color }),
      text(`   ${arrow} ${q.change > 0 ? "+" : ""}${q.change.toFixed(2)} (${pct(q.changePct)})`, { color }),
    ]),
    spacer(),
    text(sparkText(q.spark, Math.max(16, W - 8)), { color }),
    spacer(),
    divider(W - 1),
    keyValue("prev close ", price(q.prevClose, q.currency)),
    keyValue("day range  ", `${price(q.dayLow, q.currency)} – ${price(q.dayHigh, q.currency)}`),
    keyValue("52w range  ", q.yearHigh ? `${price(q.yearLow, q.currency)} – ${price(q.yearHigh, q.currency)}` : "—"),
    keyValue("volume     ", compact(q.volume)),
    spacer(),
    text(`updated ${ago(state.updatedAt)}  ·  o opens finance.yahoo.com`, { dim: true }),
  ];
}
