# Applets as executables, and the case for (not) isolating them

Issue #31 asks two questions that look like one: can an applet file *be* a
command, and should each applet get its own process? This is what shipped for
the first, and what the second measures out to.

## What shipped: `kona <path>`

`kona` takes a path as well as an applet id. Hand it a module that
default-exports `defineApplet(...)` and it opens that applet's TUI — which is
exactly what the kernel does for you when the file starts with
`#!/usr/bin/env kona` and is `chmod +x`:

```sh
kona new pomodoro --plugin --executable   # writes the shebang, sets the mode bit
~/.config/kona/plugins/pomodoro/index.ts  # ...and now the file is a command
```

Every ergonomic an installed applet has, an executable one has, because it goes
through the same two steps every time it runs:

1. **It is linked.** The path is remembered in `~/.config/kona/links.json`, and
   the loader treats those lines as a fourth source next to `applets/`,
   `~/.config/kona/plugins/` and `KONA_PLUGINS` (see `core/links.ts`). So the
   applet keeps existing after the TUI closes: `kona call pomodoro bump`,
   `kona docs pomodoro`, the launcher, `kona tools`, an agent's `GET /tools`.
   A link is a *file*, so it is the one source whose entry need not be
   `index.ts`. `kona link <file>` does this without opening the TUI, `kona
   unlink <id|file>` undoes it, and `kona ls` marks the result `(linked)`.
2. **It is registered.** `POST /applets/register {"entry":"<abs path>"}` teaches
   the *running* konad about the module — state slice, notification events,
   `init`, `tick`, cron, the manifest — so the applet is callable the moment you
   run the file rather than after the daemon's next restart.

Both steps are first-come, like the loader: a module whose id is already served
is refused (409 from the daemon, a message and exit 1 from the CLI) rather than
shadowing it. `./index.ts` cannot quietly redefine `timer` for every other
client of your daemon.

What this does **not** buy is isolation. A linked module is `import`ed into
konad like any other applet; it shares the daemon's heap and its event loop. The
executable file is an entry point, not a boundary.

## Would a boundary be worth it?

The failure mode is real. konad is one event loop, and a verb is called on it,
so an applet that blocks blocks *everything* — every other applet's tick, the
SSE stream the TUI paints from, and every agent's call. With one applet spinning
for 1.5 s in a verb (a plain `while` loop; a runaway `JSON.parse`, a pathological
regex or an accidental `await`-less busy wait would look the same):

| request | latency |
| --- | --- |
| `GET /health`, idle daemon | 0.4 ms |
| `GET /health`, while one applet's verb spins | **1454 ms** |

Nothing about that is subtle: the daemon is unavailable for as long as the worst
applet takes. Process-per-applet fixes it — and costs the following.

**IPC, per call.** A verb today is a function call; across a process boundary it
is a round trip.

| call | cost |
| --- | --- |
| verb invoked in-process | 0.6 µs |
| verb over loopback HTTP | ~200 µs (≈300×) |

For a verb that is fine — a keypress has a ~16 ms budget and 200 µs disappears
into it. The problem is `peek()`. It is a property read today (nanoseconds), and
applets lean on that: `dash` peeks half a dozen applets on every render, `sys`
and `ticker` tick every second. Cross-process, every one of those becomes a
round trip, and the composition that makes a dashboard cheap — read five
applets' live state, render — becomes a fan-out the daemon has to broker. The
per-call number is affordable; the *access pattern* is what would have to change.

**Memory.** konad with all 14 applets loaded is ~86 MB RSS. A bare Bun process
is ~30 MB before it has done anything, so fourteen of them is ~420 MB — five
times the footprint for a tool whose whole pitch is that a small thing is
instantly usable.

**Complexity, which is the real bill.** State ownership splits (one
`state.json`, N writers — so the daemon brokers writes, or persistence
fragments); `ctx.call` and `cron` cross the boundary; `notify()` needs a route
home; children need a supervision policy (restart, backoff, give up), reaping,
and a socket each; and the applets-changed watcher has to reload one child
rather than exit. That is a supervisor, and kona does not have one.

## Where this leaves it

Isolation is not worth paying for every applet, and the cheap mitigations are
not exhausted: a timeout around `invoke` would turn a wedged verb into a failed
call instead of a dead daemon, and it costs one `Promise.race`. That is the next
thing to try, and it is a much smaller diff than a supervisor.

If a specific applet does turn out to need a process — one shelling out to
something slow, or a plugin you do not trust with the event loop — the seam to
build on is already here. `register(entry)` is the handshake a supervised child
would run in reverse (a child announcing "here is my id, my verbs, my state"),
`AppletSource: "link"` already gives an out-of-tree module a first-class
identity, and the daemon now knows the file path behind every applet it serves,
which is what you need to spawn a child for one. `isolated: true` in
`defineApplet` would then be an opt-in over that machinery rather than a rewrite
of it.
