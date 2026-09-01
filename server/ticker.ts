import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Market quotes via Yahoo Finance's public chart endpoint — keyless, no account,
 * no token. One URL shape covers the whole watchlist: equities (AAPL), ETFs
 * (SPY), indices (^GSPC), FX (EURUSD=X) and crypto (BTC-USD) all answer the same
 * request. It also returns the intraday closes we draw as a sparkline, so a
 * quote and its shape cost one fetch instead of two.
 *
 *   ~/.config/kona/ticker.json   { "watchlist": ["AAPL", "BTC-USD"] }
 *   env KONA_TICKER_SYMBOLS      "AAPL,BTC-USD"   (wins over the file)
 *
 * It is a courtesy endpoint, not a contract: we cap concurrency, send a real
 * User-Agent, and surface 429/999 as a rate-limit error so callers can back off
 * (the ticker applet does, the same way dash backs off GitHub).
 */

const CONFIG_FILE = join(homedir(), ".config", "kona", "ticker.json");
// Overridable so tests can point at a local fixture server instead of the real
// endpoint (same trick as KONA_STATE_DIR in the daemon).
const chartUrl = () => process.env.KONA_TICKER_API ?? "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 kona/0.1";

/** Sensible first-run watchlist: a few majors, an index, and the two big coins. */
export const DEFAULT_WATCHLIST = ["AAPL", "NVDA", "SPY", "BTC-USD", "ETH-USD"];

/** What a symbol is, normalized from Yahoo's `instrumentType`. */
export type QuoteKind = "equity" | "etf" | "index" | "crypto" | "fx" | "other";

export interface Quote {
  symbol: string;
  name: string;
  kind: QuoteKind;
  currency: string;
  price: number;
  prevClose: number;
  /** Absolute and percent change against the previous close. */
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  yearHigh: number;
  yearLow: number;
  volume: number;
  /** True while the symbol's market is trading (crypto is always true). */
  open: boolean;
  /** Intraday closes, oldest → newest. Feeds the sparkline. */
  spark: number[];
  /** Set instead of live numbers when this one symbol failed. */
  error?: string;
}

/** A symbol as Yahoo spells it: AAPL, BRK-B, ^GSPC, EURUSD=X, BTC-USD. */
export function normalizeSymbol(input: string): string | null {
  const s = input.trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,15}$/.test(s) ? s : null;
}

/** The configured watchlist: env, then config file, then the default. */
export async function watchlist(): Promise<string[]> {
  let raw: unknown[];
  if (process.env.KONA_TICKER_SYMBOLS) {
    raw = process.env.KONA_TICKER_SYMBOLS.split(/[,\s]+/);
  } else {
    const file = await readJson<{ watchlist?: string[]; symbols?: string[] }>(CONFIG_FILE);
    raw = file?.watchlist ?? file?.symbols ?? DEFAULT_WATCHLIST;
  }
  const out = dedupe(raw.map((s) => normalizeSymbol(String(s))).filter((s): s is string => !!s));
  return out.length ? out : [...DEFAULT_WATCHLIST];
}

export function dedupe(symbols: string[]): string[] {
  const seen = new Set<string>();
  return symbols.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch {
    return null;
  }
}

function kindOf(instrumentType: string | undefined): QuoteKind {
  switch ((instrumentType ?? "").toUpperCase()) {
    case "CRYPTOCURRENCY":
      return "crypto";
    case "EQUITY":
      return "equity";
    case "ETF":
    case "MUTUALFUND":
      return "etf";
    case "INDEX":
      return "index";
    case "CURRENCY":
      return "fx";
    default:
      return "other";
  }
}

interface ChartMeta {
  currency?: string;
  symbol?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longName?: string;
  shortName?: string;
  currentTradingPeriod?: { regular?: { start?: number; end?: number } };
}

/** One symbol. Throws on transport/rate-limit failures; the caller decides. */
export async function quote(symbol: string): Promise<Quote> {
  const url = `${chartUrl()}/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => null)) as
    | { chart?: { result?: Array<{ meta?: ChartMeta; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }>; error?: { description?: string } } }
    | null;

  if (res.status === 429 || res.status === 999) throw new Error("rate limited by Yahoo Finance");
  const described = body?.chart?.error?.description;
  if (!res.ok && !described) throw new Error(`quote failed (HTTP ${res.status})`);
  if (described) throw new Error(described);

  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  const price = meta?.regularMarketPrice;
  if (!meta || typeof price !== "number") throw new Error("no quote data");

  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  const period = meta.currentTradingPeriod?.regular;
  const nowSec = Date.now() / 1000;
  const kind = kindOf(meta.instrumentType);

  return {
    symbol: meta.symbol ?? symbol,
    name: meta.shortName ?? meta.longName ?? (meta.symbol ?? symbol),
    kind,
    currency: meta.currency ?? "USD",
    price,
    prevClose,
    change: price - prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
    dayHigh: meta.regularMarketDayHigh ?? price,
    dayLow: meta.regularMarketDayLow ?? price,
    yearHigh: meta.fiftyTwoWeekHigh ?? 0,
    yearLow: meta.fiftyTwoWeekLow ?? 0,
    volume: meta.regularMarketVolume ?? 0,
    open:
      kind === "crypto" ||
      (typeof period?.start === "number" &&
        typeof period?.end === "number" &&
        nowSec >= period.start &&
        nowSec <= period.end),
    spark: closes.length ? [...closes, price] : [prevClose, price],
  };
}

/**
 * The whole watchlist, in the order given. A symbol that fails on its own comes
 * back as a Quote carrying `error` (a typo'd ticker shouldn't blank the board);
 * a failure that hits EVERY symbol throws, so the caller can back off.
 */
export async function quotes(symbols: string[], concurrency = 4): Promise<Quote[]> {
  const out: Quote[] = new Array(symbols.length);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < symbols.length; i = cursor++) {
      const symbol = symbols[i]!;
      try {
        out[i] = await quote(symbol);
      } catch (e) {
        out[i] = failed(symbol, e instanceof Error ? e.message : String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));

  const results = out.filter(Boolean);
  const firstError = results.find((q) => q.error)?.error;
  if (results.length && results.every((q) => q.error)) throw new Error(firstError ?? "quotes failed");
  return results;
}

function failed(symbol: string, error: string): Quote {
  return {
    symbol,
    name: symbol,
    kind: "other",
    currency: "USD",
    price: 0,
    prevClose: 0,
    change: 0,
    changePct: 0,
    dayHigh: 0,
    dayLow: 0,
    yearHigh: 0,
    yearLow: 0,
    volume: 0,
    open: false,
    spark: [],
    error,
  };
}

/** The human page for a symbol — what `o` opens in the browser. */
export function webUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}
