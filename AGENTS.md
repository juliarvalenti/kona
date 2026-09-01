# Agent guide

kona is designed so *you* (an agent) are a first-class client, equal to the
human at the keyboard. You never open the TUI; you talk to the daemon.

## How to act

1. Read the manifest: `GET /tools` (or `kona tools`) → a list of
   `<applet>.<verb>` names you may call.
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

## Notifications

Verbs you fire can reach the human's screen: applets call `notify()` from
`server/notify.ts` on events the human opted into (`kona notify`). So
`timer.start` from you means a banner for them when it finishes — that is the
point, not a side effect. Events are deduped and rate limited; you do not need
to throttle your own calls.

## Daemon

Base URL: `http://localhost:${KONA_PORT:-4177}`. Autostarts via the CLI; to run
it yourself: `kona daemon`.
