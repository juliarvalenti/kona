# approvals

The human-in-the-loop tray. kona's thesis is that a keypress and an agent's
HTTP call fire the **same verb over the same state** — which is the magic, and
also the gap: you pressed the key, so the key confirms itself; nothing confirms
the POST. So the daemon **holds** an untrusted caller's far-reaching verbs
instead of running them, and parks them here for you.

Agent proposes, human disposes.

```sh
kona approvals                       # what is waiting, and what your agents did
kona approvals approve p3            # run it (with one waiting, the id is optional)
kona approvals deny p3               # drop it
```

At the keyboard: `a` approves the selected action, `d` denies it, `A`/`D` do the
whole queue, `tab` switches to the **activity log**, `c` clears that log. The
selected action shows its **exact arguments** — the mail body, the room, the id
being deleted — because "approve email.send" is not a decision anyone can
actually make.

## How a verb gets held

Every verb has an **effect level**, declared by the applet that wrote it (see
`Effect` in `sdk/index.ts`), and guessed from its name when it doesn't say:

| level | means | examples |
| --- | --- | --- |
| `read` | changes nothing | `email.refresh`, `clock.list` |
| `local` | this applet's own state | `timer.start`, `notes.add` |
| `external` | leaves the machine as you | `email.send`, `mycelium.post`, `spotify.playPause` |
| `destructive` | does not come back | `email.trash` |

A **trusted** caller — the TUI, `kona <applet>`, `kona approvals` — runs
anything: a human is right there. Everything else is an agent, and by default
its `external` and `destructive` verbs are held. `kona tools --json` marks them
`"guarded": true`, so an agent can see the wait coming.

## What the agent sees

```
POST /applets/email/verbs/send   ->  202
{ "ok": false, "pending": "p3", "action": { ... }, "hint": "held for a human: …" }
```

Nothing ran. The proposal waits (ten minutes by default), and the agent watches
`GET /approvals/p3` — or the `approval` SSE event on `/events` — for the
decision and the verb's actual result. A denial or an expiry is a final answer,
not a retry hint.

A workflow step is the same call from inside the daemon, so an **agent's**
workflow run pauses at its first guarded step and resumes the moment you
approve it. A human's does not pause at all.

## Configuring it

```toml
[security]
hold  = "default"                 # external + destructive (the shipped policy)
# hold = "all-writes"             # ...or anything that isn't a pure read
# hold = "none"                   # ...or nothing at all
allow = ["spotify.playPause"]     # these run regardless
guard = ["notes.clear"]           # ...and these are always held
expire = "10m"                    # how long a pending action waits for you
```

`allow`/`guard` take `applet.verb`, `applet.*` or a bare `applet`, and win over
`hold` in both directions. `KONA_TRUST_AGENTS=1` in the daemon's environment
trusts every caller — the pre-approval behaviour, kept as an escape hatch.

## Trust, honestly

The trust signal is a token in `~/.local/state/kona/trust.token` (mode 0600)
that the TUI sends back in a header. It is **not** a secret from you: anything
running as your user can read it, and could already drop a file into
`applets/`. It marks the surface a human is typing into, so an agent has to
*choose* to impersonate a keypress rather than doing it by accident — which is
the failure this guards against.

The queue and the log live in the daemon's memory and go with it on restart.
That is the right amount of memory for "someone asked to send this ten minutes
ago", and the reason this applet is `ephemeral`.
