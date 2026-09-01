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
core/      applet loader + HTTP client shared by daemon and host
applets/
  timer/   the walking-skeleton proof
```

## Use

```sh
bun install

kona                       # launcher: pick an app
kona timer 5m              # open the timer, pre-started
kona ls                    # list applets
kona tools                 # the manifest an agent reads
kona call timer start '{"seconds":300}'   # ← exactly what an agent does
kona state timer           # read current state
```

The daemon (`konad`) autostarts on first use; state lives in
`~/.local/state/kona/state.json`.

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

## Writing an applet

Drop a `applets/<name>/index.ts` that default-exports `defineApplet(...)`. Its
`verbs` run in the daemon and are auto-exposed to agents; its `view` and
`keymap` are picked up by the host. That's the whole extension surface — see
`applets/timer/index.ts`.

## Status

v0 walking skeleton. The daemon, SDK, agent seam, cron tick, and shared-state
loop are verified. The OpenTUI host is written against the pinned API and runs
in a real terminal (it needs a TTY; it won't render under a pipe).
