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
```

You get a working applet, its snapshot fixtures, a unit test and a README:

```
applets/pomodoro/
  index.ts         defineApplet(...) as the default export — the applet
  snapshots.ts     rendering fixtures, discovered by tests/snapshot.test.ts
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
| `AppletCtx` | `state`, `emit()`, `peek(id)` — what a verb and a tick get |
| `theme()` / `appletConfig(id)` | the palette and your own settings block |
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

```ts
export default defineApplet<PomodoroState>({
  id: "pomodoro",
  title: "Pomodoro",
  summary: "One line for the launcher.",
  labels: ["focus"],
  requires: ["nothing"],
  initialState: { round: 0 },
  verbs: { start: (args, { state, emit }) => { /* ... */ } },
  docs: { start: { doc: "Start a round.", args: { minutes: 25 } } },
  notifications: { "pomodoro.done": { summary: "a round ends", default: true } },
  cli: { usage: "kona pomodoro 50m", open: (args) => (args[0] ? { verb: "start", args: { minutes: args[0] } } : null) },
  configSample: `[applets.pomodoro]\nwork = "25m"`,
  view: (state) => [/* ... */],
});
```

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

The first package to claim an id wins, so a broken plugin can never shadow a
built-in; a plugin that throws on import is skipped with a warning rather than
taking the daemon down. `KONA_NO_PLUGINS=1` limits a run to this repo — the test
suite sets it so your installed plugins can't change what the suite sees.

## Before you open a PR

```sh
bun run check     # tsc --noEmit
bun test          # the whole suite
```

Both must be green. If your change touches rendering, look at it:
`bun run bin/snapshot.ts <applet>` prints a real frame with no TTY.

Conventions: comments explain WHY (the constraint, the trade-off), not what the
next line does; prose in docs is plain and specific. Follow the file you are
editing.
