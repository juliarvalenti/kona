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

An applet will also show you itself. `bun run bin/snapshot.ts <applet> --hero`
renders its portrait — the frame the README gallery uses — as plain text, with
no TTY, no account and no live data, so "what does this look like?" is a
question you can answer before you touch anyone's state.

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

The human can also hand you one surface at a time: `y` in the TUI (or `kona
prompt <applet>`) copies a prompt for the applet they are looking at — the same
manifest, scoped to one applet, with `--skill` rendering it as a SKILL.md
stanza. If they paste one at you, it is current by construction.

The rendered file is generated, never committed — `bun run skill` writes it, and
a `SessionStart` hook does that for you. If it looks stale, regenerate it; if it
disagrees with `kona tools --json`, the manifest wins.

## Building an applet

If you are here to ADD an applet, the rule is that you edit **no shared file**:

```sh
kona new <id>            # applets/<id>/ — applet, fixtures, test, README
kona new <id> --plugin   # ...or ~/.config/kona/plugins/<id>, outside the repo
kona new <id> --executable   # ...and make index.ts runnable on its own
bun test applets/<id> && bun run check
```

An applet you did not write arrives the same way it would for a human:
`kona plugin install <git-url|path>` clones or copies a package into
`~/.config/kona/plugins/`, `kona plugin list` says what is installed and where
it came from, and `kona plugin remove <name>` deletes it. Installing one adds
verbs to the manifest, so re-read `kona tools` (or regenerate the skill)
afterwards.

An applet file can also live nowhere in particular: `kona link <file.ts>` (or
running a `chmod +x` module with `#!/usr/bin/env kona` on line one) hands it to
the daemon and remembers it, so `kona call <id> <verb>` works from that moment
on with no restart and no directory to install into.

Everything the platform needs it reads out of that one directory: the loader
finds `index.ts`, `bun test` finds `<id>.test.ts`, the snapshot runner finds
`snapshots.ts`, `kona docs <id>` prints `README.md`. Your applet's own
definition also declares its desktop notifications, its `kona login` provider,
its CLI arguments and its config block — so there is no registry to append to
and your branch cannot conflict with another agent's. `CONTRIBUTING.md` has the
full contract; if you find yourself editing a file outside your package to make
your applet work, that is a platform bug worth reporting.

## Verbs that need a human

You are not the human at the keyboard, and the daemon can tell: a keypress
confirms itself, an HTTP call does not. So every verb carries a **priority** —
`low` (reads and kona-local state), `medium` (reversible remote effects:
playback, mark-read), `high` (acts as them: sends the mail, posts the message)
or `critical` (does not come back) — and the machine's `[security]` policy in
`config.toml` decides which of those you may fire on your own. By default `high`
and `critical` are **held**.

A held call runs nothing and answers `202`:

```json
{ "ok": false, "pending": "p3", "hint": "held for a human: high-priority verbs need a human" }
```

It is a proposal, and it is now in front of them — in the `approvals` applet,
on the dash, and as a desktop banner. Approving runs the verb and hands you its
real result; denying or letting it expire drops it.

```sh
kona tools --json                # every verb's `priority`, and `guarded: true`
kona call email send '{...}'     # -> { pending: "p3" }, exit code 2
curl -s localhost:4177/approvals/p3   # "pending", then "ran" with the result
```

Four rules: **wait, don't retry** (re-firing queues a second copy — poll
`/approvals/<id>` or watch the `approval` event on `/events`); **a denial is an
answer**, not an obstacle to route around; **send the real arguments**, because
the human approves what they can see; and **never try to approve your own** —
`approvals.approve` refuses every caller but the human. A workflow you start
pauses at its first guarded step and resumes when that step is approved.

If you are being asked to act unattended and the waiting is wrong for the job,
say so — the human can `allow` a verb, or set `hold = "none"`, in one line of
config. Don't work around the tray.

## Notifications

Verbs you fire can reach the human's screen: applets call `notify()` from
`server/notify.ts` on events the human opted into (`kona notify`). So
`timer.start` from you means a banner for them when it finishes — that is the
point, not a side effect. Events are deduped and rate limited; you do not need
to throttle your own calls.

## Workflows

Anything you can call twice, you can name once. The `workflows` applet stores
named sequences of verb calls; the daemon can run them on a schedule:

```sh
kona call workflows define '{"name":"triage","steps":[
  "email.refresh",
  "mycelium.post {\"room\":\"{{params.room}}\",\"text\":\"inbox: {{steps.0.unread}} unread\"}"]}'
kona call workflows run '{"name":"triage","params":{"room":"ship-kona"}}'
kona call workflows schedule '{"name":"triage","cron":"0 9 * * 1-5"}'
```

Steps see the run: `{{params.…}}`, `{{steps.<n>.…}}` (or `{{steps.<as>.…}}`),
`{{last.…}}`, `{{now}}` — a reference alone keeps its type, one inside a
sentence is interpolated — and a step's `when` skips it when false. A failing
step stops the run; `kona state workflows` has the history, newest first. The
human sees the same list in the TUI and the next scheduled run on the dash, so
say what a workflow does in its `summary` rather than leaving them to read the
steps.

`export`/`import` move a workflow between machines as a SKILL.md-shaped
document — frontmatter plus literal `kona call` lines — so a workflow you write
here is a skill someone else can read.

## Coordination

`mycelium` is not a dashboard you appear in — it is a room you can talk in, and
the human is in it with you:

```sh
kona call mycelium post '{"room":"ship-kona","text":"picking up #38"}'
kona call mycelium status '{"status":"running the test suite"}'
kona call mycelium remember '{"room":"ship-kona","key":"plan","value":"composer first"}'
kona state mycelium        # rooms, who is present, and what was just said
```

`post` is the same verb the human's composer fires, so your message shows up in
their open room the moment you send it (and, if they opted into
`mycelium.message`, as a desktop banner when they're elsewhere). Say what you
are doing before a long job, not after.

## Daemon

Base URL: `http://localhost:${KONA_PORT:-4177}`. Autostarts via the CLI; to run
it yourself: `kona daemon`.
