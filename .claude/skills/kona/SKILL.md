---
name: kona
description: Drive kona applets as an agent: discover what is installed from the live tool manifest, read applet state, fire verbs, and watch the event stream. Use when asked to act on a kona applet from the command line — clock (world clock), dash (dashboard), email, mycelium, notes, rss, spotify, storybook, sys (system), ticker, timer, weather, webex, workflows.
---

# Driving kona

kona applets are **bimodal**: one applet is a view a human browses in a terminal
*and* a set of verbs you call — over one shared state, in one process. The human
presses `space` to pause a countdown; you call `timer.pause`; the applet cannot
tell the difference and does not care. There is nothing keyboard-only to work
around, text fields included.

A verb you fire repaints whatever the human is looking at, and can reach their
screen as a desktop notification. That is the point, not a side effect — but it
does mean you should leave state coherent, and prefer small named verbs over
sweeping mutations.

## The four calls

| What | CLI | HTTP |
| --- | --- | --- |
| Discover the verbs | `kona tools --json` | `GET http://localhost:4177/tools` |
| Read state | `kona state <applet>` | `GET http://localhost:4177/applets/<id>/state` |
| Fire a verb | `kona call <applet> <verb> '<json>'` | `POST http://localhost:4177/applets/<id>/verbs/<verb>` |
| Watch changes | — | `GET http://localhost:4177/events` (SSE: `snapshot`, then `state`) |

The daemon (`konad`) autostarts on the first CLI call. `KONA_PORT` moves the
port. A verb call answers with `{ ok, result, state }` — the applet's whole
state after the call — so you rarely need a follow-up read.

## Rules of engagement

1. **Discover, don't hardcode.** An applet is a directory — in kona's own
   `applets/`, or installed as a plugin — so a machine can have more (or
   fewer) than the ones below. Start from `kona tools --json` and
   act on what is actually installed. If this file and the manifest disagree,
   the manifest wins — regenerate with `kona tools --skill`.
2. **Address rows by name, not by cursor.** Verbs that act on a selection take
   `id`, `label`, or `index` as well; use them. Moving the cursor (`up`/`down`)
   is the human's affordance and races with them.
3. **Read the result.** The state a verb returns tells you whether it landed
   (e.g. a timer's `status`, an applet's `error` field). Applets report failure
   in state rather than throwing HTTP errors.
4. **Refresh before you read** an applet backed by a network service, unless its
   tick has been running — `refresh` on `dash`, `email`, `mycelium`, `rss`, `spotify`, `sys`, `ticker`, `weather`, `webex`.

## Applets on this machine

Installed: `clock`, `dash`, `email`, `mycelium`, `notes`, `rss`, `spotify`, `storybook`, `sys`, `ticker`, `timer`, `weather`, `webex`, `workflows`.

### clock — World Clock

Every city you care about, at a glance. Add zones by hand or by agent.

- `clock.list` — Read the board without changing it; `tz` reads any zone, on the board or not.  ·  `kona call clock list '{"tz":"Asia/Kathmandu"}'`
- `clock.add` — Add a city (an IANA zone, or a name from the catalog).  ·  `kona call clock add '{"tz":"Europe/Lisbon"}'`
- `clock.remove` — Remove a city from the board.  ·  `kona call clock remove '{"tz":"Europe/Lisbon"}'`, key `d`
- `clock.sort` — Order the board west -> east.  ·  `kona call clock sort`, key `s`
- `clock.format` — 12- or 24-hour clock.  ·  `kona call clock format '{"hour12":true}'`, key `t`
- `clock.pick` — Open the city picker.  ·  `kona call clock pick`, key `a`
- `clock.find` — Filter the picker's catalog.  ·  `kona call clock find '{"q":"tokyo"}'`
- `clock.choose` — Add the highlighted city from the picker.  ·  `kona call clock choose`

Cursor verbs (the keyboard's business — address a row by id or index instead): `close`, `up`, `down`.

Searchable: `clock.find` takes `{"q": "..."}`.

### dash — Dashboard

Live cockpit — now playing, timer, mail, GitHub. Leave it open.

- `dash.refresh` — Re-aggregate the dashboard from the other applets' live state, and refetch GitHub.  ·  `kona call dash refresh`, key `r`
- `dash.open` — Open a row: a GitHub PR/issue in the browser, or jump to the Spotify applet.  ·  `kona call dash open '{"index":0}'`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`.

### email — Email

Read, write, reply and file mail from Gmail and Outlook in one list.

- `email.refresh` — Reload the inbox. Call this before you read state.  ·  `kona call email refresh`, key `r`
- `email.search` — Run a Gmail query and replace the list with its results.  ·  `kona call email search '{"q":"is:unread newer_than:1d"}'`
- `email.more` — Fetch the next page of threads.  ·  `kona call email more`
- `email.accounts`  ·  `kona call email accounts`
- `email.account`  ·  `kona call email account`
- `email.open` — Open a thread by list `index` and load its body. Marks it read.  ·  `kona call email open '{"index":0}'`
- `email.cycleAccount`  ·  `kona call email cycleAccount`, key `a`
- `email.compose` — Send a new message. With no `to`, opens the composer instead.  ·  `kona call email compose '{"to":"ada@x.com","subject":"dinner","body":"friday?"}'`, key `n`
- `email.reply` — Reply to a thread (`id`, or whatever is open). With no `body`, opens the composer prefilled.  ·  `kona call email reply '{"id":"18f2c…","body":"on it — shipping tonight."}'`, key `return`
- `email.replyAll` — Reply keeping everyone else on the thread.  ·  `kona call email replyAll '{"id":"18f2c…","body":"thanks all"}'`, key `g`
- `email.forward` — Forward a thread to someone else.  ·  `kona call email forward '{"id":"18f2c…","to":"grace@x.com"}'`, key `f`
- `email.draft` — Save a message as a provider draft instead of sending it.  ·  `kona call email draft '{"to":"ada@x.com","subject":"dinner","body":"half-written…"}'`
- `email.drafts` — List saved drafts (and show them in place of the inbox).  ·  `kona call email drafts`, key `s`
- `email.openDraft` — Reopen a saved draft in the composer, by `index` or `id`.  ·  `kona call email openDraft '{"index":0}'`
- `email.send` — Send what the composer holds. Prefer compose/reply, which fill it in for you.  ·  `kona call email send`
- `email.field` — The composer's plumbing: set one field. `compose.to`, `.cc`, `.subject`.  ·  `kona call email field '{"id":"compose.to","value":"ada@x.com"}'`
- `email.next` — The composer's plumbing: move to the next field (what tab presses).  ·  `kona call email next`
- `email.form` — The composer's plumbing: commit a field — on the body, a line; on an empty line, send.  ·  `kona call email form '{"id":"compose.body","value":"friday?"}'`
- `email.dismiss` — Close the composer (or the label prompt), keeping what was typed.  ·  `kona call email dismiss`
- `email.archive` — Archive a thread — out of the inbox, still in the mailbox.  ·  `kona call email archive '{"id":"18f2c…"}'`, key `e`
- `email.trash` — Move a thread to the trash.  ·  `kona call email trash '{"id":"18f2c…"}'`, key `d`
- `email.label` — Apply a label (Gmail) / category (Outlook), creating it if it is new.  ·  `kona call email label '{"id":"18f2c…","name":"todo"}'`, key `t`
- `email.markRead` — Clear the unread dot on a thread.  ·  `kona call email markRead '{"id":"18f2c…"}'`
- `email.markUnread` — Put it back.  ·  `kona call email markUnread '{"id":"18f2c…"}'`
- `email.toggleRead` — Flip a thread between read and unread.  ·  `kona call email toggleRead '{"id":"18f2c…"}'`, key `u`

Cursor verbs (the keyboard's business — address a row by id or index instead): `back`, `down`, `up`.

Searchable: `email.search` takes `{"q": "..."}`.

### mycelium — Mycelium

The coordination layer — rooms, agents, and what you say to them.

- `mycelium.refresh` — Re-read the room list (and the open room) from the backend.  ·  `kona call mycelium refresh`, key `r`
- `mycelium.open` — Drill into a room by `room` id — agents, recent messages, shared memory.  ·  `kona call mycelium open '{"room":"ship-kona"}'`
- `mycelium.search` — Filter rooms by name, topic, or a member agent.  ·  `kona call mycelium search '{"q":"kona"}'`
- `mycelium.compose`  ·  `kona call mycelium compose`, key `return`
- `mycelium.draft`  ·  `kona call mycelium draft`
- `mycelium.blur`  ·  `kona call mycelium blur`
- `mycelium.post`  ·  `kona call mycelium post`
- `mycelium.create`  ·  `kona call mycelium create`, key `n`
- `mycelium.status`  ·  `kona call mycelium status`, key `s`
- `mycelium.remember`  ·  `kona call mycelium remember`, key `m`
- `mycelium.field`  ·  `kona call mycelium field`
- `mycelium.next`  ·  `kona call mycelium next`
- `mycelium.form`  ·  `kona call mycelium form`
- `mycelium.dismiss`  ·  `kona call mycelium dismiss`

Cursor verbs (the keyboard's business — address a row by id or index instead): `back`, `up`, `down`.

Searchable: `mycelium.search` takes `{"q": "..."}`.

### notes — Notes

A scratchpad that survives restarts. Agents jot lines too.

- `notes.add` — Jot a line. Newest first.  ·  `kona call notes add '{"text":"ship the skill generator"}'`
- `notes.edit` — Replace a note's text, by `id` or `index`.  ·  `kona call notes edit '{"id":"a1b2c3d4","text":"ship it tomorrow"}'`
- `notes.remove` — Delete a note, by `id` or `index`. Undoable.  ·  `kona call notes remove '{"id":"a1b2c3d4"}'`, key `d`
- `notes.clear` — Wipe the pad. Undoable.  ·  `kona call notes clear`
- `notes.undo` — Step back one mutation (add, edit, remove, clear).  ·  `kona call notes undo`, key `u`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`.

Searchable: `notes.add` takes `{"q": "..."}`.

### rss — RSS

Your feeds as one river. Agents can search and open items too.

- `rss.refresh` — Refetch every feed and rebuild the river.  ·  `kona call rss refresh`, key `r`
- `rss.search` — Filter the river locally — no refetch, so it is instant.  ·  `kona call rss search '{"q":"bun"}'`
- `rss.more` — Show the next page of items.  ·  `kona call rss more`
- `rss.open` — Open an item by `index` and read its text.  ·  `kona call rss open '{"index":0}'`
- `rss.browser` — Hand the open (or selected) item to a browser.  ·  `kona call rss browser`, key `o`

Cursor verbs (the keyboard's business — address a row by id or index instead): `back`, `down`, `up`.

Searchable: `rss.search` takes `{"q": "..."}`.

### spotify — Spotify

Now playing + transport control.

- `spotify.refresh` — Re-read now-playing, the queue, and the active device. Call this before you read state.  ·  `kona call spotify refresh`
- `spotify.playPause` — Toggle playback.  ·  `kona call spotify playPause`, key `space`
- `spotify.next` — Skip to the next track.  ·  `kona call spotify next`, key `n`
- `spotify.previous` — Back to the previous track.  ·  `kona call spotify previous`, key `p`
- `spotify.shuffle` — Toggle shuffle.  ·  `kona call spotify shuffle`, key `s`
- `spotify.repeat` — Cycle repeat: off -> context -> track.  ·  `kona call spotify repeat`, key `r`
- `spotify.seek` — Scrub. Agents pass an absolute `positionMs`; the arrow keys pass `deltaMs`.  ·  `kona call spotify seek '{"positionMs":90000}'`, key `left`
- `spotify.volume` — Set the volume (`pct`) or nudge it (`delta`), 0-100.  ·  `kona call spotify volume '{"pct":40}'`, key `+`
- `spotify.queue` — Queue a track to play after the current one — by `uri`, or by free-text `q` we resolve to the first match.  ·  `kona call spotify queue '{"q":"four tet rave green"}'`, key `q`
- `spotify.devices` — List Spotify Connect devices (and open the picker for the human).  ·  `kona call spotify devices`, key `d`
- `spotify.transfer` — Hand playback to another device, by `id` or by `name`.  ·  `kona call spotify transfer '{"name":"kitchen"}'`
- `spotify.search` — Search the catalog — artists, albums, playlists, tracks.  ·  `kona call spotify search '{"q":"four tet"}'`
- `spotify.more` — Append the next page of track results.  ·  `kona call spotify more`
- `spotify.home` — Load recently played, top artists and your playlists.  ·  `kona call spotify home`, key `b`
- `spotify.enter` — Act on a row of the current screen: play a track, open an artist/album, pick a device.  ·  `kona call spotify enter '{"index":0}'`

Cursor verbs (the keyboard's business — address a row by id or index instead): `back`, `up`, `down`.

Searchable: `spotify.search` takes `{"q": "..."}`.

### storybook — Storybook

Live gallery of kona components.

- `storybook.edit` — Give the demo text field the keyboard (state owns the focus).  ·  `kona call storybook edit`, key `i`
- `storybook.save` — Commit a value into the field — what `enter` does for a human.  ·  `kona call storybook save '{"value":"ada"}'`
- `storybook.ask` — Raise the confirm dialog (the overlay demo).  ·  `kona call storybook ask`, key `m`
- `storybook.ok` — Confirm the dialog.  ·  `kona call storybook ok`
- `storybook.cancel` — Drop the edit and dismiss the dialog.  ·  `kona call storybook cancel`

### sys — System

Live CPU, memory, disk, and battery gauges.

- `sys.refresh` — Take a full reading now — load, memory, disk, battery, network. This is the one you want.  ·  `kona call sys refresh`, key `r`
- `sys.mount` — Point the disk gauge at another filesystem.  ·  `kona call sys mount '{"path":"/Volumes/ext"}'`

### ticker — Ticker

Watchlist board — stocks and crypto, price, %chg, sparkline.

- `ticker.refresh` — Poll quotes now, ignoring the every-45s gate.  ·  `kona call ticker refresh`, key `r`
- `ticker.add` — Add symbols to the watchlist (comma- or space-separated).  ·  `kona call ticker add '{"symbols":"NVDA, BTC-USD"}'`
- `ticker.remove` — Drop a symbol.  ·  `kona call ticker remove '{"symbol":"NVDA"}'`, key `x`
- `ticker.reset` — Re-seed the watchlist from config (env / ~/.config/kona/ticker.json).  ·  `kona call ticker reset`
- `ticker.select` — Open the detail screen for the selected symbol.  ·  `kona call ticker select`
- `ticker.web` — Open the selected symbol's page in a browser.  ·  `kona call ticker web`, key `o`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`, `back`.

Searchable: `ticker.add` takes `{"q": "..."}`.

### timer — Timer

Countdowns and a pomodoro. Presets 1/2/3; space pauses; p pomodoro.

- `timer.start` — Start a countdown. `seconds` takes 300, "5m" or "1h30m"; `label` names it. Naming an existing `id` restarts that one.  ·  `kona call timer start '{"seconds":300,"label":"tea"}'`, key `1`
- `timer.pause` — Pause a countdown — by `id`, `label`, `index`, else the selected one.  ·  `kona call timer pause '{"id":"t1"}'`
- `timer.resume` — Resume a paused countdown.  ·  `kona call timer resume '{"id":"t1"}'`
- `timer.toggle` — Pause or resume, whichever applies (the `space` key).  ·  `kona call timer toggle '{"id":"t1"}'`, key `space`
- `timer.add` — Add time to a running countdown.  ·  `kona call timer add '{"id":"t1","seconds":60}'`, key `a`
- `timer.stop` — Remove a countdown; `{"all":true}` clears every one.  ·  `kona call timer stop '{"id":"t1"}'`, key `s`
- `timer.clear` — Drop the countdowns that already finished.  ·  `kona call timer clear`, key `c`
- `timer.label` — Rename a countdown.  ·  `kona call timer label '{"id":"t1","to":"steep"}'`
- `timer.select` — Move the human's selection to a countdown.  ·  `kona call timer select '{"id":"t1"}'`
- `timer.pomodoro.start`  ·  `kona call timer pomodoro.start`
- `timer.pomodoro.pause`  ·  `kona call timer pomodoro.pause`
- `timer.pomodoro.resume`  ·  `kona call timer pomodoro.resume`
- `timer.pomodoro.toggle`  ·  `kona call timer pomodoro.toggle`, key `p`
- `timer.pomodoro.skip`  ·  `kona call timer pomodoro.skip`, key `n`
- `timer.pomodoro.stop`  ·  `kona call timer pomodoro.stop`, key `x`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`.

### weather — Weather

Current conditions and the week ahead, from open-meteo.

- `weather.refresh` — Refetch the current location. Call this before you read state.  ·  `kona call weather refresh`, key `r`
- `weather.setLocation` — Move the view — coordinates, or a place name in `q` that gets geocoded.  ·  `kona call weather setLocation '{"q":"Lisbon"}'`
- `weather.locate` — Guess the location from the IP address.  ·  `kona call weather locate`, key `l`
- `weather.search` — Geocode a query and offer the matches to pick from.  ·  `kona call weather search '{"q":"Porto"}'`
- `weather.units` — Switch units.  ·  `kona call weather units '{"fahrenheit":true}'`, key `u`
- `weather.open` — Open a day in the forecast, or adopt a search result.  ·  `kona call weather open '{"index":0}'`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`, `back`.

Searchable: `weather.search` takes `{"q": "..."}`.

### webex — Webex

Spaces, their messages, and a verb that posts back.

- `webex.refresh`  ·  `kona call webex refresh`, key `r`
- `webex.search`  ·  `kona call webex search`
- `webex.open`  ·  `kona call webex open`
- `webex.compose`  ·  `kona call webex compose`, key `c`
- `webex.cancel`  ·  `kona call webex cancel`
- `webex.post`  ·  `kona call webex post`
- `webex.read`  ·  `kona call webex read`, key `a`

Cursor verbs (the keyboard's business — address a row by id or index instead): `back`, `up`, `down`.

Searchable: `webex.search` takes `{"q": "..."}`.

### workflows — Workflows

Named sequences of applet verbs — run them by hand, or on a cron.

- `workflows.define` — Create or replace a workflow. `steps` takes `"applet.verb {json}"` lines or `{applet,verb,args}` objects; `cron` schedules it. With no `name` (a keypress) it opens the TUI's new-workflow form.  ·  `kona call workflows define '{"name":"morning","summary":"Start the day","cron":"30 8 * * 1-5","steps":["spotify.play {\"uri\":\"spotify:playlist:37i9dQZF1DX0XUsuxWHRQd\"}","timer.start {\"seconds\":1500,\"label\":\"focus\"}","notes.add {\"text\":\"focus block started {{now}}\"}"]}'`, key `n`
- `workflows.run` — Run a workflow now. `params` fills its `{{params.x}}` references; the result reports every step.  ·  `kona call workflows run '{"name":"morning","params":{"room":"ship-kona"}}'`, key `r`
- `workflows.runStep` — Fire ONE step on its own — how you test a step while building.  ·  `kona call workflows runStep '{"name":"morning","index":0}'`, key `return`
- `workflows.addStep` — Append a step (same line format as `define`); `index` inserts instead. No `step` opens the builder field.  ·  `kona call workflows addStep '{"name":"morning","step":"notes.add {\"text\":\"stand-up in 10\"}"}'`, key `a`
- `workflows.removeStep` — Drop a step by position (0-based).  ·  `kona call workflows removeStep '{"name":"morning","index":2}'`, key `x`
- `workflows.schedule` — Put a workflow on the daemon's clock: a 5-field cron expression, `@daily`, or `@every 10m`; `null` clears it. The daemon then fires it exactly like an agent calling `workflows.run`.  ·  `kona call workflows schedule '{"name":"morning","cron":"30 8 * * 1-5"}'`, key `c`
- `workflows.toggle` — Pause or resume a schedule without losing the expression.  ·  `kona call workflows toggle '{"name":"morning","enabled":false}'`, key `p`
- `workflows.remove` — Delete a workflow. With no `name` (a keypress) it asks first.  ·  `kona call workflows remove '{"name":"morning"}'`, key `d`
- `workflows.confirm` — Answer the delete dialog's question.  ·  `kona call workflows confirm`
- `workflows.field` — A keystroke in the open form's field. The TUI's business — pass whole arguments to define/addStep/schedule instead.  ·  `kona call workflows field`
- `workflows.form` — Submit the open form, through the same verb the form is filling in.  ·  `kona call workflows form`
- `workflows.dismiss` — Close the open form or dialog.  ·  `kona call workflows dismiss`
- `workflows.export` — Render a workflow as a portable SKILL.md-shaped document (frontmatter + `kona call` steps). `all` exports every one.  ·  `kona call workflows export '{"name":"morning"}'`
- `workflows.import` — Define a workflow from that document — how one machine's workflow lands on another.  ·  `kona call workflows import '{"markdown":"---\nname: morning\nschedule: 30 8 * * 1-5\n---\n\n## Steps\n\n```sh\nkona call timer start '{\"seconds\":1500}'\n```\n"}'`
- `workflows.clear` — Forget the run history (the workflows stay).  ·  `kona call workflows clear`
- `workflows.open` — Show one workflow's steps (what `kona workflows <name>` opens into).  ·  `kona call workflows open '{"name":"morning"}'`

Cursor verbs (the keyboard's business — address a row by id or index instead): `up`, `down`, `back`.

## Worked examples

**Triage the inbox**

```sh
kona call email refresh
kona call email search '{"q":"is:unread newer_than:1d"}'   # -> { count: 12 }
kona state email                                            # threads[]: from, subject, snippet
kona call email open '{"index":0}'                          # -> the body, and the dot clears
kona call email archive '{"index":0}'                       # or trash / label / markUnread
```

Triage is reading AND filing: archive what is done, label what needs a human, leave the rest unread.

**Answer a thread**

```sh
kona call email open '{"index":0}'
kona call email reply '{"body":"on it — shipping tonight."}'   # replyAll keeps the cc list
kona call email compose '{"to":"ada@x.com","subject":"dinner","body":"friday?"}'
kona call email draft '{"to":"ada@x.com","subject":"dinner","body":"half-written…"}'
```

`reply` with no body opens the composer prefilled (quoted text and recipients) for the human instead — same verb, both callers.

**Read a mycelium room**

```sh
kona call mycelium refresh                          # -> { rooms: 4, source: "http" }
kona call mycelium open '{"room":"ship-kona"}'      # -> agents, message count, memory keys
kona state mycelium                                  # the messages themselves
```

Read-only by design: kona observes the coordination layer, it does not post to it. Say something in a room with your own mycelium client; kona is the window, not the mouth.

**Queue a track without stopping what is playing**

```sh
kona call spotify queue '{"q":"four tet rave green"}'   # -> { queued: true, track: "..." }
kona state spotify                                       # upNext now leads with it
```

Needs `kona login spotify` and an active device (`kona call spotify devices`). To play something *now* instead, `spotify.search` then `spotify.enter {"index":N}`.

**Start a focus timer, then extend it**

```sh
kona call timer start '{"seconds":1500,"label":"focus"}'   # -> { id: "t1", status: "running" }
kona state timer                                            # every countdown, with remaining
kona call timer add '{"id":"t1","seconds":300}'             # +5m, without touching the cursor
```

Address the countdown by the `id` the start verb handed back — never by moving the cursor, which the human may also be moving. When it hits zero the daemon posts a desktop banner (`kona notify on timer.done`).

**Define a workflow and run it**

```sh
kona call workflows define '{"name":"focus","steps":["timer.start {\"seconds\":1500,\"label\":\"focus\"}","notes.add {\"text\":\"focus block at {{now}}\"}"]}'
kona call workflows run '{"name":"focus"}'    # -> { ok: true, steps: [...] }
kona state workflows                          # the run history, newest first
```

Steps are ordinary verb calls — anything in `kona tools` can be one.

**Put a workflow on the daemon's clock**

```sh
kona call workflows schedule '{"name":"focus","cron":"30 8 * * 1-5"}'
kona call workflows toggle '{"name":"focus","enabled":false}'   # pause, keep the expression
```

The daemon fires scheduled workflows itself — no terminal has to be open.

**Feed one step's result to the next**

```sh
kona call workflows define '{"name":"triage","steps":["email.refresh","mycelium.post {\"room\":\"{{params.room}}\",\"text\":\"inbox: {{steps.0.unread}} unread\"}"]}'
kona call workflows run '{"name":"triage","params":{"room":"ship-kona"}}'
```

`{{steps.<n>.…}}`, `{{last.…}}`, `{{params.…}}` and `{{now}}` resolve per run; a step's `when` skips it.

**Move a workflow to another machine**

```sh
kona call workflows export '{"name":"focus"}'    # -> { markdown: "---\nname: focus\n..." }
kona call workflows import '{"markdown":"<that document>"}'
```

The document is SKILL.md-shaped: frontmatter plus literal `kona call` lines, so it reads as a skill.

---

Generated from the live manifest by `kona tools --skill`. Re-run it after
adding an applet — `kona tools --skill --out .claude/skills/kona/SKILL.md`.
