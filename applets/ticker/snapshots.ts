import { defineSnapshots } from "../../sdk/testing.ts";

const QUOTES = [
  {
    symbol: "AAPL", name: "Apple Inc.", kind: "equity", currency: "USD",
    price: 316.85, prevClose: 319.7, change: -2.85, changePct: -0.891,
    dayHigh: 321.24, dayLow: 312.8, yearHigh: 344.57, yearLow: 225.95,
    volume: 40667429, open: true, spark: [319, 318, 317.5, 318.2, 316, 315.4, 316.85],
  },
  {
    symbol: "BTC-USD", name: "Bitcoin USD", kind: "crypto", currency: "USD",
    price: 77859.73, prevClose: 78559.11, change: -699.38, changePct: -0.765,
    dayHigh: 79159.34, dayLow: 77932, yearHigh: 126198.07, yearLow: 57747.76,
    volume: 29379194880, open: true, spark: [78732, 78844, 78680, 78377, 78191, 77859.73],
  },
];

export default defineSnapshots([
  {
    name: "board lists symbols with price, %chg, and a sparkline",
    state: () => ({ symbols: ["AAPL", "BTC-USD", "ETH-USD"], quotes: QUOTES, cursor: 0, updatedAt: Date.now() }),
    width: 90,
    height: 16,
    contains: [
      "MARKETS", "AAPL", "Bitcoin USD",
      "77,859.73", // grouped price
      "-0.89%", // signed percent change
      "█▆▅▇▂▁▄", // AAPL's intraday shape, as a sparkline
      "ETH-USD", // a symbol without a quote yet still gets a row
    ],
  },
  {
    name: "detail shows the day's numbers and a wide sparkline",
    state: () => ({ symbols: ["BTC-USD"], quotes: QUOTES, open: "BTC-USD", updatedAt: Date.now() }),
    width: 76,
    height: 22,
    contains: [
      "BTC-USD", "crypto",
      "▼", // down arrow
      "prev close", "78,559.11",
      "77,932.00 – 79,159.34", // day range
      "29B", // compact volume
    ],
  },
  {
    name: "an empty watchlist explains how to fill it",
    state: { symbols: [] },
    width: 72,
    height: 14,
    contains: ["Watchlist empty", "ticker.json"],
  },
]);
