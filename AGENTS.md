# Agent guide

kona is designed so *you* (an agent) are a first-class client, equal to the
human at the keyboard. You never open the TUI; you talk to the daemon.

## How to act

1. Read the manifest: `GET /tools` (or `kona tools --json`) → every
   `<applet>.<verb>` you may call, each with what it does, example args you can
   send as-is, and the key a human presses for the same thing. Never hardcode
   an applet id: the list is whatever is installed on this machine.
2. Fire a verb: `POST /applets/<id>/verbs/<verb>` with a JSON body of args, or
   `kona call <id> <verb> '<json>'`. The response includes the resulting state.
3. Read state anytime: `GET /applets/<id>/state` (or `kona state <id>`).
4. Watch changes: `GET /events` (SSE) streams `snapshot` then `state` events.

The human may be looking at the same applet while you act — your verb call
repaints their view. Prefer small, named verbs over sweeping mutations, and
leave state coherent (an applet's `view` must always make sense).

Text fields are no exception. A field on screen is an `input` node whose value
lives in state, so you fill one by calling its verb — `storybook.save
{"value":"ada"}` — exactly as a human pressing enter would. There is nothing
keyboard-only to work around.

## The skill

`GET /skill` (or `kona tools --skill`) renders the whole thing as a drop-in
agent skill — the model above, the per-applet verbs, and worked examples for
starting a timer, queueing a track, triaging the inbox and reading a mycelium
room. It is generated from the applets the daemon actually loaded, so it cannot
describe a verb this machine doesn't have. Install it with
`kona tools --skill --install` (writes `.claude/skills/kona/SKILL.md`), and
re-run that after adding an applet.

Applets feed it from their own definition: a `docs` block (one line per verb,
plus example args) and `recipes` (multi-step flows). Document a verb where you
write it and the skill follows.

## Notifications

Verbs you fire can reach the human's screen: applets call `notify()` from
`server/notify.ts` on events the human opted into (`kona notify`). So
`timer.start` from you means a banner for them when it finishes — that is the
point, not a side effect. Events are deduped and rate limited; you do not need
to throttle your own calls.

## Daemon

Base URL: `http://localhost:${KONA_PORT:-4177}`. Autostarts via the CLI; to run
it yourself: `kona daemon`.
