# Contributing to kona

The one rule that shapes everything else:

> **Adding an applet edits no shared file.**

Not the README, not a test registry, not a notification catalogue, not the CLI.
An applet is a directory; kona discovers it, its tests, its fixtures and its
docs from that directory alone. This is what lets a swarm of agents each build
an applet in parallel and merge without conflicts — and if you find yourself
appending to a file outside your package to make your applet work, that is a
bug in the platform. Say so, or fix it.

## Scaffold one

```sh
kona new pomodoro              # applets/pomodoro/ (ships with kona)
kona new pomodoro --plugin     # ~/.config/kona/plugins/pomodoro (yours alone)
kona new pomodoro --out ~/src/pomodoro
kona new pomodoro --executable # ...and make index.ts a command (see below)
```

You get a working applet, its snapshot fixtures, a unit test and a README:

```
applets/pomodoro/
  index.ts         defineApplet(...) as the default export — the applet
  snapshots.ts     rendering fixtures; the first (or `hero: true`) is the
                   applet's portrait in the README gallery
  pomodoro.test.ts unit tests, discovered by `bun test`
  README.md        the prose, printed by `kona docs pomodoro`
```

Then:

```sh
bun test applets/pomodoro     # your package's tests
bun run check                 # tsc over the repo, applet packages included
kona pomodoro                 # the daemon restarts itself when applets change
```

## The plugin ABI

Everything below is stable — target it. Everything else (the daemon's internals,
`host/`, `server/*`) is kona's business and may change.

| surface | what it is |
| --- | --- |
| `defineApplet(...)` from `sdk/index.ts` | the applet contract, typed |
| the view vocabulary | `text`, `big`, `row`, `col`, `box`, `bar`, `input`, `spacer` |
| `sdk/components.ts` | composed widgets: lists, meters, sparklines, cards, modals |
| `sdk/markdown.ts` | `renderMarkdown(md)` — a markdown document as view nodes |
| `AppletCtx` | `state`, `emit()`, `peek(id)`, `applets()` — what a verb and a tick get |
| `theme()` / `appletConfig(id)` | the palette (and its figlet) plus your own settings block |
| `theme(state)` on the definition | retint the whole UI while your applet is open |
| `sdk/testing.ts` | `renderApplet`, `defineSnapshots`, `testSnapshots` |
| `sdk/fake.ts` | `fakeProviders(routes)` — answer an applet's provider calls from fixtures |

An applet is a pure object over its own state slice. `verbs` run in the daemon;
`view` is a pure `state -> nodes` render the host draws; `keymap`/`nav` bind
keys to the same verbs an agent calls over HTTP. Never reach for the terminal
directly, and never assume a human is present — a verb must work with nothing on
screen, and a view must make sense whenever a verb leaves state behind.

### The definition is also the manifest

The fields that used to be entries in shared files:

| field | replaces |
| --- | --- |
| `docs` / `recipes` | hand-written agent docs — they generate the skill |
| `notifications` | an entry in `EVENTS` in `server/notify.ts` |
| `auth` | an entry in the CLI's provider table (`kona login <name>`) |
| `cli` | an `if (cmd === "…")` branch in `bin/kona.ts` |
| `configSample` | a block in the starter file `kona config init` writes |
| `labels` / `requires` | a paragraph appended to the README |
| `dash` | a branch in the dashboard's aggregator — your own line on the cockpit |
| `effects` | a hardcoded list of "dangerous verbs" somewhere central |

```ts
export default defineApplet<PomodoroState>({
  id: "pomodoro",
  title: "Pomodoro",
  summary: "One line for the launcher.",
  icon: "◕",            // your glyph in the launcher — ONE cell, no emoji
  tint: "#ff5c57",      // your brand color there (accent(state) stays the live frame tint)
  labels: ["focus"],
  requires: ["nothing"],
  initialState: { round: 0 },
  verbs: { start: (args, { state, emit }) => { /* ... */ } },
  priority: { start: "low", announce: "high" },   // how much oversight each verb needs
  docs: { start: { doc: "Start a round.", args: { minutes: 25 } } },
  notifications: { "pomodoro.done": { summary: "a round ends", default: true } },
  cli: { usage: "kona pomodoro 50m", open: (args) => (args[0] ? { verb: "start", args: { minutes: args[0] } } : null) },
  configSample: `[applets.pomodoro]\nwork = "25m"`,
  dash: (state) => (state.round ? { priority: 60, text: `◕ round ${state.round}` } : null),
  view: (state) => [/* ... */],
});
```

### Say how much oversight a verb needs

Your verbs run for a human pressing a key AND for an agent that nobody
confirmed. `priority` is where you say how far each one reaches, per verb:

```ts
priority: { send: "high", trash: "critical", playPause: "medium", draft: "low" },
```

`low` is a read or your own state slice; `medium` is a reversible remote effect
(playback, mark-read, archive); `high` acts as the user and commits (sends the
mail, posts the message); `critical` does not come back. Anything you leave out
is guessed from the verb's NAME, and the guess is deliberately jumpy — `clear`
reads as critical — so declare the ones where you know better. `spotify.playPause`
is `medium` because a paused track is a reversible nudge; `email.send` is `high`.

By default an untrusted caller's `high` and `critical` verbs are parked for the
human in the `approvals` applet instead of running. That is a promise your
applet is making on its own behalf: mark a verb `medium` (or `low`) because you
know it is recoverable, never to spare an agent the wait.

### Say what is live, and land on the dashboard

`dash(state)` is the one field another applet reads. The dashboard asks every
loaded applet what it has to say right now and draws the answers, urgency first,
so a card is how your applet reaches a screen nobody opened:

```ts
dash: (state) =>
  state.unread ? { priority: 50, text: `✉ ${state.unread} unread` } : null,
```

Return `null` (or `show: false`) when nothing is going on — an idle applet
contributes nothing, which is what keeps the cockpit free of empty counters.
Return an array when two things can be live at once. `priority` runs 0..100 (80+
on fire, 60 live, 40 waiting on you, 20 ambient, 5 calm) and the row jumps into
your applet when it is selected. It is pure, like `view`, and it is called about
once a second: read state, return a line, do no work.

### Tests live with the applet

Two kinds, both discovered:

```ts
// applets/pomodoro/snapshots.ts — rendering, declarative
export default defineSnapshots([
  { name: "a running round shows the clock", state: { round: 1 }, contains: ["25:00"] },
]);

// applets/pomodoro/pomodoro.test.ts — behaviour, ordinary bun tests
test("start opens a round", () => { /* drive the verbs like the daemon does */ });
```

`tests/snapshot.test.ts` is a runner, not a registry: it walks the loaded
packages and runs whatever `snapshots.ts` it finds, in the repo and in plugins
alike. A plugin outside the repo also gets a two-line `snapshots.test.ts` from
the scaffolder, since nothing in this checkout scans its directory.

### One fixture is the hero

The first fixture in the list — or whichever one says `hero: true` — is the
applet's **portrait**. It is an ordinary fixture, asserted on like the rest;
being the hero only means two more things happen to it:

```sh
bun run bin/snapshot.ts pomodoro --hero   # "show me what you look like"
bun run shots                             # docs/shots/*.svg + the README gallery
```

`bun run shots` renders every applet's hero in one fixed 80x24 window, at a
pinned clock and the default theme, writes it to `docs/shots/<id>.svg`, and
regenerates the README's gallery from the packages the loader found — so a new
applet's portrait slots in without anyone editing the README. `tests/shots.test.ts`
then holds the committed images to a fresh render: change what an applet looks
like and the suite fails until you re-run it. Two rules follow from that:

- **Every applet ships at least one fixture** (the suite enforces it), and the
  hero should be the frame you would show someone — the applet doing its job,
  not its empty state.
- **A hero must render the same twice.** Build state from `Date.now()` in a
  state *function* (`at: Date.now() - 5 * 60_000` reads "5m ago" forever)
  rather than pinning a literal epoch that drifts into "3 years ago". Inside
  the function, not beside it: the renderer stops the clock while it draws
  (`pinned()` in `core/shots.ts` swaps the whole `Date`, so `new Date()` in a
  stamp is covered too), and a module-level `const` stamped at import time is
  outside that pin — it lands the real wall clock in a committed image, which
  then goes stale on its own and fails the suite on unrelated PRs (#66).
  `tests/shots-clock.test.ts` re-checks the gallery on a machine whose clock
  says it is weeks from now, which is what catches this.

`tests/` itself is for the PLATFORM — `sdk/`, `core/`, `host/`, and the
`server/` seams shared by more than one applet. If a test only makes sense for
one applet, it belongs in that applet's package.

### No test touches a real account

Every provider call in `server/` goes through `providerFetch()`
(`server/transport.ts`), and the suite preload sets `KONA_FAKE_PROVIDERS=1`. A
call that would leave the machine throws, saying so. This is not paranoia: a
`bun test` on a signed-in machine once fired real seek/volume/transfer commands
at the human's Spotify.

An applet whose verbs fetch installs a fake and asserts on what it WOULD have
sent:

```ts
import { fakeProviders } from "../../sdk/fake.ts";
import { spotifyRoutes } from "../../tests/fixtures/spotify.ts";

const fake = fakeProviders(spotifyRoutes());   // reads answer from fixtures
await spotify.verbs.volume!({ pct: 55 }, ctx); // writes are recorded, not sent
expect(fake.writes().map((c) => c.line)).toEqual(["PUT /v1/me/player/volume?volume_percent=55"]);
fake.restore();
```

Recorded payloads live in `tests/fixtures/<provider>.ts`; an unrouted read says
which fixture is missing, and an unrouted write answers 204 so the verb takes
its success path. A localhost URL is always allowed through, so a fixture server
a test starts itself (`KONA_GMAIL_API`, `KONA_TICKER_API`, `KONA_WEBEX_API`,
`KONA_SPOTIFY_API`) works as before. A `gh`-based provider has the same seam:
`setGhRunner()` in `server/github.ts`.

The real provider stays reachable on purpose, from a `*.live.test.ts` that calls
`allowLive()` — it needs `KONA_LIVE=1` too, so a stray flag can't unlock the
rest of the suite:

```sh
KONA_LIVE=1 bun test applets/spotify/spotify.live.test.ts
```

## Applets outside the repo

kona loads applets from, in order:

1. `applets/*/` in this checkout
2. `~/.config/kona/plugins/*/`
3. `plugins = ["~/src/mine"]` in `~/.config/kona/config.toml`, and
   `KONA_PLUGINS` (colon-separated). Each entry is one package (a dir with an
   `index.ts`) or a dir full of them.
4. linked modules — single files you ran directly, listed in
   `~/.config/kona/links.json` (below). The one source that is a file, not a
   directory, so its entry need not be called `index.ts`.

The first package to claim an id wins, so a broken plugin can never shadow a
built-in; a plugin that throws on import is skipped with a warning rather than
taking the daemon down. `KONA_NO_PLUGINS=1` limits a run to this repo — the test
suite sets it so your installed plugins (and links) can't change what the suite
sees.

### Installing one

Discovery is half the story; `kona plugin install` is the other half — getting
a package someone else built into (2) without a hand-rolled `git clone`. An
applet that can never live in this repo (a private API, an internal SSO) ships
as its own package and arrives this way.

```sh
kona plugin install git@github.com:me/kona-tome.git   # clone into the plugin dir
kona plugin install ~/src/kona-tome [--link]          # copy a local package, or symlink it
kona plugin install <src> --as tome                   # name the directory yourself
kona plugin list                                      # ids, kind, and where each came from
kona plugin remove tome                               # delete it
```

The rules it holds to:

- The destination is always `~/.config/kona/plugins/<name>/` — the dir the
  loader already scans, so an install registers nothing and edits no config.
- A path that exists beats any git spelling, so `./thing.git` on disk is copied,
  not fetched. A copy leaves `node_modules` and `.git` behind.
- `bun install` runs in a cloned or copied package that has a `package.json`,
  and never in a `--link`ed one: that directory is somebody's working checkout.
- An install that produced no `index.ts` is undone, and a failed clone leaves
  nothing behind — a half-installed directory the loader silently ignores is
  worse than an error.
- `kona plugin remove <name>` deletes the directory, or, for a `--link`, the
  symlink and not the checkout behind it.
- The filesystem is the source of truth. `~/.config/kona/plugins.json` records
  only where each install came from, so a package you copied in by hand lists
  and removes like any other, and deleting that file loses provenance, never an
  applet.
- `plugins = [...]` roots are loaded but not managed here: `kona plugin remove`
  only ever touches the plugin dir.

## An applet as an executable

`kona` takes a path as well as an applet id, so an applet file can be a command
of its own: put `#!/usr/bin/env kona` on line one, `chmod +x`, and `./index.ts`
opens it. `kona new <id> --executable` writes both for you.

```sh
kona ~/src/pomodoro/index.ts   # run a module directly (what the shebang does)
kona link ~/src/pomodoro/index.ts   # ...without opening the TUI
kona unlink pomodoro                # forget it
kona link                           # what is linked here
```

Running a module **links** it — the path is remembered in `links.json`, so the
applet outlives the command and an agent can `kona call` it — and **registers**
it with the running daemon (`POST /applets/register`), so it is callable
immediately rather than after the next restart. A module whose id is already
installed is refused, not merged: first-come, exactly as the loader does it.

The file is an entry point, not a sandbox — a linked module is imported into
konad like every other applet, so a wedged verb still wedges the daemon. The
case for giving an applet its own process, with the numbers, is in
[docs/applet-processes.md](docs/applet-processes.md).

## Before you open a PR

```sh
bun run check     # tsc --noEmit
bun test          # the whole suite
```

Both must be green. If your change touches rendering, look at it:
`bun run bin/snapshot.ts <applet>` prints a real frame with no TTY, and
`bun run shots` refreshes the README gallery (commit the images it writes —
`bun run shots --check` is the same question without the writes).

Conventions: comments explain WHY (the constraint, the trade-off), not what the
next line does; prose in docs is plain and specific. Follow the file you are
editing.
