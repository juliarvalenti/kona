# dash

The live cockpit: one line per applet that has something going on, most urgent
first, meant to be left open.

The dash owns almost no data. Every applet answers `dash(state)` about itself —
a song, a countdown about to fire, unread mail, a workflow due in 12 minutes, a
disk about to fill — and the dash collects those cards from the applets the
daemon actually loaded, keeps the ones that say something is *live*, and orders
them by urgency. An applet with nothing going on contributes nothing, so the
board never fills up with "0 unread".

That also means installing an applet is the only step there is: a plugin with a
`dash` card appears here with no edit to this package. The one thing the dash
fetches for itself is GitHub — the PRs and issues involving you, under the
cards.

```sh
kona dash
kona state dash                     # `cards` is exactly what is on the screen
kona call dash refresh '{}'
kona call dash open '{"index":0}'   # jump into the applet, or open the PR
```

`→` (or a click) on a card jumps into the applet that contributed it; on a
GitHub row it opens the item in a browser. With nothing live anywhere, the dash
says "all quiet" rather than drawing an empty instrument panel.

## Contributing a card

Anywhere in an applet definition:

```ts
dash: (state) =>
  state.unread ? { priority: 50, text: `✉ ${state.unread} unread` } : null,
```

Return `null` (or `show: false`) when nothing is live, one card, or several.
`priority` runs 0..100 — 80+ is on fire, 60 is live and moving, 40 is waiting on
you, 20 ambient, 5 calm — and `navigate` overrides which applet the row jumps
into. See `DashCard` in `sdk/index.ts`; the collecting and ordering is
`applets/dash/cards.ts`, the only file that knows there is a board at all.

## Config

```toml
[applets.dash]
accent = "#1db954"
density = "compact"                  # only the cards that want something from you
pin = ["timer", "email"]             # these first, in this order
hide = ["weather", "timer:pomodoro"] # by applet, or by <applet>:<card id>
```

## Notifications

`github.new` — a PR or issue involving you shows up. On by default.
