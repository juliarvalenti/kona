import { test, expect, afterAll } from "bun:test";
import { quote, quotes, watchlist, normalizeSymbol, webUrl, DEFAULT_WATCHLIST } from "../../server/ticker.ts";
import { sparkText, sparkline } from "../../sdk/components.ts";

/**
 * The quote layer, driven against a local fixture server (KONA_TICKER_API) that
 * speaks the same shape as Yahoo's chart endpoint — so parsing, per-symbol
 * failure, and the all-failed backoff signal are covered without the network.
 */

function chartBody(over: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            currency: "USD",
            symbol: "AAPL",
            instrumentType: "EQUITY",
            regularMarketPrice: 316.85,
            chartPreviousClose: 319.7,
            regularMarketDayHigh: 321.24,
            regularMarketDayLow: 312.8,
            regularMarketVolume: 40667429,
            fiftyTwoWeekHigh: 344.57,
            fiftyTwoWeekLow: 225.95,
            shortName: "Apple Inc.",
            currentTradingPeriod: { regular: { start: 0, end: 4102444800 } }, // wide-open window
            ...over,
          },
          indicators: { quote: [{ close: [319.1, null, 317.4, 318.2] }] },
        },
      ],
    },
  };
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const symbol = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
    if (symbol === "NOPE") {
      return Response.json({ chart: { result: null, error: { description: "No data found, symbol may be delisted" } } }, { status: 404 });
    }
    if (symbol === "BUSY") return new Response("slow down", { status: 429 });
    if (symbol === "BTC-USD") {
      return Response.json(chartBody({ symbol: "BTC-USD", instrumentType: "CRYPTOCURRENCY", shortName: "Bitcoin USD", regularMarketPrice: 77859.73, chartPreviousClose: 78559.11 }));
    }
    return Response.json(chartBody());
  },
});
process.env.KONA_TICKER_API = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

test("quote parses price, change, and the sparkline series", async () => {
  const q = await quote("AAPL");
  expect(q.symbol).toBe("AAPL");
  expect(q.name).toBe("Apple Inc.");
  expect(q.kind).toBe("equity");
  expect(q.price).toBe(316.85);
  expect(q.change).toBeCloseTo(-2.85, 2);
  expect(q.changePct).toBeCloseTo(-0.891, 2);
  expect(q.open).toBe(true);
  // nulls dropped, live price appended as the last point
  expect(q.spark).toEqual([319.1, 317.4, 318.2, 316.85]);
});

test("crypto is always open and keeps its own name", async () => {
  const q = await quote("BTC-USD");
  expect(q.kind).toBe("crypto");
  expect(q.open).toBe(true);
  expect(q.name).toBe("Bitcoin USD");
  expect(q.changePct).toBeLessThan(0);
});

test("a bad symbol reports Yahoo's description", async () => {
  expect(quote("NOPE")).rejects.toThrow(/delisted/);
});

test("a rate limit is named as one, so callers can back off", async () => {
  expect(quote("BUSY")).rejects.toThrow(/rate limited/i);
});

test("one bad symbol doesn't blank the board", async () => {
  const rows = await quotes(["AAPL", "NOPE", "BTC-USD"]);
  expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "NOPE", "BTC-USD"]);
  expect(rows[1]!.error).toMatch(/delisted/);
  expect(rows[1]!.price).toBe(0);
  expect(rows[0]!.error).toBeUndefined();
});

test("quotes throws only when every symbol failed (the backoff signal)", async () => {
  expect(quotes(["NOPE", "BUSY"])).rejects.toThrow();
});

test("watchlist reads the env override, normalized and deduped", async () => {
  const prev = process.env.KONA_TICKER_SYMBOLS;
  process.env.KONA_TICKER_SYMBOLS = "aapl, btc-usd  aapl,!!!";
  expect(await watchlist()).toEqual(["AAPL", "BTC-USD"]);
  process.env.KONA_TICKER_SYMBOLS = "";
  if (prev === undefined) delete process.env.KONA_TICKER_SYMBOLS;
  else process.env.KONA_TICKER_SYMBOLS = prev;
});

test("normalizeSymbol accepts real ticker shapes and rejects junk", () => {
  expect(normalizeSymbol(" aapl ")).toBe("AAPL");
  expect(normalizeSymbol("brk-b")).toBe("BRK-B");
  expect(normalizeSymbol("^gspc")).toBe("^GSPC");
  expect(normalizeSymbol("eurusd=x")).toBe("EURUSD=X");
  expect(normalizeSymbol("hello world")).toBeNull();
  expect(normalizeSymbol("")).toBeNull();
});

test("webUrl points at the symbol's finance page", () => {
  expect(webUrl("BTC-USD")).toBe("https://finance.yahoo.com/quote/BTC-USD");
  expect(webUrl("^GSPC")).toContain("%5EGSPC"); // escaped
});

test("the default watchlist mixes stocks and crypto", () => {
  expect(DEFAULT_WATCHLIST).toContain("AAPL");
  expect(DEFAULT_WATCHLIST.some((s) => s.endsWith("-USD"))).toBe(true);
});

test("sparkText draws a rising series and buckets to the requested width", () => {
  expect(sparkText([1, 2, 3, 4])).toBe("▁▃▆█");
  expect(sparkText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toHaveLength(5);
  expect(sparkText([5, 5, 5])).toBe("▄▄▄"); // flat draws a mid-line, not a full bar
  expect(sparkText([])).toBe("");
  expect(sparkText([1, NaN, 3])).toHaveLength(2); // non-finite points dropped
});

test("sparkline scales a series into a colorable text node", () => {
  expect(sparkline([1, 2, 3], { color: "#0f0", width: 3 })).toMatchObject({
    kind: "text",
    text: "▁▅█",
    color: "#0f0",
  });
});
