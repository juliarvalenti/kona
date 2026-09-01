# ticker

A watchlist board — stocks, ETFs, indices and crypto alike — with price, change,
and an intraday sparkline. No account: quotes come from a keyless public
endpoint.

Set the watchlist once and it stays warm in the daemon:

```jsonc
// ~/.config/kona/ticker.json
{ "watchlist": ["AAPL", "NVDA", "SPY", "BTC-USD", "ETH-USD"] }
```

or `KONA_TICKER_SYMBOLS="AAPL,BTC-USD"`. In the applet, `/` adds a symbol and
`x` drops the selected one; `→` opens the day's numbers for one. An agent does
the same:

```sh
kona call ticker add '{"symbol":"NVDA"}'
kona call ticker remove '{"symbol":"SPY"}'
kona call ticker refresh '{}'
```
