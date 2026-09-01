# kona

**Bimodal terminal applets.** An applet is a view *you* browse **and** a set of
verbs an *agent* calls — over one shared state, in one process. You press
`space` to pause a timer; an agent calls `timer.start` with no window open; both
drive the same state and neither can tell the difference. That indifference is
the whole idea.

Think Commodore-64 immediacy — write a small thing, it's instantly usable — but
for an agentic era, and without MCP's ceremony.

## Why not just MCP?

MCP makes a tool *either* agent-callable (headless, JSON) *or* a thing you look
at — never both. kona collapses that: an applet is a pure object

```ts
{ view, verbs, keymap }   // over shared state
```

and *who* fires a verb (your keypress vs. the agent's HTTP call) is irrelevant
to the applet. The daemon owns state; the TUI is just one client; an agent is
just another client.

## Shape

```
server/    konad — owns state (KV, persisted), runs the cron tick, streams SSE
host/      OpenTUI client — launcher ("pick an app") → applet view → keymap
sdk/       defineApplet({ view, verbs, keymap, tick }) + the tool manifest
core/      applet loader, config/theme, HTTP client — shared by daemon and host
applets/
  timer/   the walking-skeleton proof
```

## Use

```sh
bun install

kona                       # your default applet, else the launcher
kona launcher              # always the launcher: pick an app
kona timer 5m              # open the timer, pre-started
kona ls                    # list applets
kona tools                 # the manifest an agent reads
kona call timer start '{"seconds":300}'   # ← exactly what an agent does
kona state timer           # read current state
kona config                # show the resolved config (init writes a starter)
```

The daemon (`konad`) autostarts on first use; state lives in
`~/.local/state/kona/state.json`.

In the TUI, `↑`/`↓` (or `k`/`j`) move, `→`/`enter` opens, `←`/`esc` goes back,
and `/` searches. The mouse works the same way: click a row to select and open
it, scroll the wheel to scroll.

### Desktop notifications

The daemon can post native macOS banners when something happens — a countdown
hits zero, a new PR involves you, unread mail lands — so an always-open dash is
actually ambient. Every event is opt-in and toggled from the CLI:

```sh
kona notify                    # what can fire, and what's on
kona notify on email.unread    # opt in
kona notify off timer.done     # opt out  (`all` for the master switch)
kona notify test               # prove it reaches your screen
```

Settings live in `~/.config/kona/notify.json`; the daemon picks up a change
within a second. `KONA_NOTIFY=0 kona daemon` runs a silent session. Banners go
through `terminal-notifier` when it's installed (clickable — a GitHub banner
opens the PR) and `osascript` otherwise; elsewhere than macOS it's a no-op.

Applets fire them from any verb or tick:

```ts
import { notify } from "../../server/notify.ts";
void notify({ event: "timer.done", title: "Timer", body: "05:00 is up." });
```

Repeats of the same `key` inside a window are dropped and a burst is rate
limited, so a re-sync can't spam you. Add a new event to `EVENTS` in
`server/notify.ts` to make it listable and toggleable.

### Gmail

`kona login` runs a Google OAuth loopback flow (read-only) and stores the
refresh token in the macOS Keychain. Create a Desktop OAuth client, enable the
Gmail API, and save the JSON to `~/.config/kona/google.json`.

For best HTML-email rendering, install a text renderer (same ones aerc/mutt
use); kona picks the first available, else falls back to a JS converter:

```sh
brew install w3m     # or: pandoc / lynx / elinks
```

### RSS

`rss` reads its feed list from `~/.config/kona/rss.toml` — a list of URLs, or
tables when you want to name a feed:

```toml
feeds = ["https://news.ycombinator.com/rss"]

[[feeds]]
name = "xkcd"
url  = "https://xkcd.com/atom.xml"
```

RSS 2.0 and Atom both work. Feeds are merged into one newest-first river,
refreshed every five minutes; `/` filters it, `o` opens the selected item in a
browser.

### Mycelium

The `mycelium` applet is a read-only window onto your coordination layer —
rooms, the agents in them, recent messages, and shared memory. It finds the
data wherever it lives, in this order:

```sh
MYCELIUM_URL=http://127.0.0.1:8765   # the local daemon / OpenAPI backend
mycelium                             # the CLI, on PATH or ~/.local/bin/mycelium
~/.mycelium/rooms/                   # room files (dirs or JSONL logs)
```

```sh
kona mycelium                        # browse rooms, → to drill in, ← back
kona call mycelium open '{"room":"ship-kona"}'   # ← what an agent does
```

### Ticker

The `ticker` applet needs no account — quotes come from a keyless public
endpoint that covers stocks, ETFs, indices and crypto alike. Set the watchlist
once and it stays warm in the daemon:

```jsonc
// ~/.config/kona/ticker.json
{ "watchlist": ["AAPL", "NVDA", "SPY", "BTC-USD", "ETH-USD"] }
```

or `KONA_TICKER_SYMBOLS="AAPL,BTC-USD"`. In the applet, `/` adds a symbol and
`x` drops the selected one; an agent does the same with
`kona call ticker add '{"symbol":"NVDA"}'`.

## Config

Everything tweakable lives in one optional file, `~/.config/kona/config.toml`.
With no file you get the defaults below — `kona config init` writes them out
commented, `kona config` prints what's actually in effect (and any complaints
about the file; a bad value is ignored, never fatal).

```toml
default = "dash"      # applet a bare `kona` opens; omit for the launcher

[theme]               # the palette — applets name ROLES, never hexes
accent = "#7aa2f7"    # frames, selection, links
alt    = "#bb9af7"    # secondary tint
fg     = "#d0d0d0"    # body text
dim    = "#6a6a6a"    # labels, hints
muted  = "#5a5a5a"    # idle / inactive
ok     = "#00d488"    # running, unread, success
warn   = "#f0b000"    # paused, degraded
error  = "#ff5c57"    # failure
key    = "#e6e6e6"    # keybind glyphs
bg     = "#0b0b0b"    # text on an accent fill

[applets.spotify]     # per-applet blocks
accent = "#1db954"    # `accent` retints any applet's frame
[applets.timer]
default = "5m"        # `kona timer` with no argument
[applets.email]
page = 20             # threads per fetch
```

Ten roles retheme all of kona because no applet hardcodes a color: they call
`theme().ok` and the stage paints from the same table.

```ts
import { text, theme } from "../../sdk/index.ts";

view: (s) => [text(s.done ? "done" : "working", { color: theme().ok })]
```

`appletConfig("<id>")` hands an applet its own `[applets.<id>]` block, and
`appletAccent`/`appletString`/`appletNumber` read one key with a fallback.

## Writing an applet

Drop a `applets/<name>/index.ts` that default-exports `defineApplet(...)`. Its
`verbs` run in the daemon and are auto-exposed to agents; its `view` and
`keymap` are picked up by the host. Colors come from `theme()` and settings from
`appletConfig("<id>")` — both re-exported by the SDK, so `sdk/index.ts` is the
whole extension surface. See `applets/timer/index.ts`.

### Typing into an applet

`input(id, value, opts)` is a real editable text field you put in the view tree.
State owns both the text and the focus, so it stays bimodal:

```ts
input("name", state.name, { focus: state.editing, submit: "save", cancel: "cancel" })
```

While the field has focus the host takes every key (arrows move the caret,
readline bindings work, `enter` submits, `esc` cancels) and fires `save` with
`{ id, value }`. An agent skips the keyboard and calls the same verb:

```sh
kona call storybook save '{"value":"ada"}'
```

Pass `change` instead of waiting for `enter` to get a verb per keystroke; see
the `input` section of the storybook applet for a live one.

## Status

v0 walking skeleton. The daemon, SDK, agent seam, cron tick, and shared-state
loop are verified. The OpenTUI host is written against the pinned API and runs
in a real terminal (it needs a TTY; it won't render under a pipe).
