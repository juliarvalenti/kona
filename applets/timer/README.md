# timer

Countdowns and a pomodoro cycle, in the daemon — so they keep running with no
terminal open, and finish with a sound and a desktop banner.

```sh
kona timer 5m                                # open it, pre-started
kona timer pomodoro                          # ...or a 25/5 work-break cycle
kona call timer start '{"seconds":300,"label":"tea"}'
kona call timer pause '{"id":"t1"}'          # id, label or index — your pick
kona state timer
```

Several countdowns run at once; `1`/`2`/`3` start the presets, `space` pauses
the selected one, `s` stops it and `c` clears the finished ones.

## Pomodoro

The pomodoro cycle — work → short break → … → long break — runs *alongside* the
plain countdowns, not instead of them. Each phase counts down in the daemon,
hands itself to the next one, and banners the desktop on the way past
(`timer.pomodoro`, toggleable on its own). The view shows the phase, the round
you're on and how many you've banked today.

A live session is not a second screen with its own keys, though: it is the top
row of the same list. `↑`/`↓` walk across the session and the countdowns, the
selected one is the hero, and `space` pauses whichever it is — so you never have
to know which of two pause keys the screen is currently listening to. The same
goes for an agent: `timer.pause`, `resume`, `toggle`, `add` and `stop` with no
argument act on the selection (the reply's `kind` says which they reached), and
naming a countdown by `id`, `label` or `index` always reaches that countdown.

```sh
kona timer pomodoro                                  # or `p` in the TUI
kona call timer pomodoro.start '{"work":"50m","short":"10m"}'
kona call timer pomodoro.skip '{}'                   # "skip this break"
kona call timer pomodoro.pause '{}'                  # ...and .resume/.toggle/.stop
kona call timer toggle '{}'                          # ...or just "pause what's selected"
kona call timer select '{"pomodoro":true}'           # put the selection back on the session
```

In the TUI: `p` starts a session and pauses/resumes it wherever the cursor is,
`space` pauses it while it holds the selection, `n` skips the current phase and
`x` ends the session.

## Config

```toml
[applets.timer]
default = "5m"   # what `kona timer` with no argument starts, when nothing is running

[applets.timer.pomodoro]
work  = "25m"   # a duration string, or a bare number of MINUTES
short = "5m"
long  = "15m"
every = 4       # long break after every 4th work phase
auto  = false   # wait for `p` at each boundary instead of rolling on
```

## Sounds

Every ending makes a noise, so a timer works from the next room — and the three
endings sound different, because "your break is over" and "the pasta is done"
are not the same news:

| moment | cue |
| --- | --- |
| a countdown reaches zero | `alarm` |
| a work phase ends — break time | `chime` |
| a break ends — back to it | `rise` |

`kona sound` lists the tones (`chime`, `bell`, `alarm`, `soft`, `rise`, `fall`)
and `kona sound alarm` plays one, so you can hear a cue before you commit to it.
A tone is a job, not a file: each one names a sound the OS already ships
(macOS's own, the freedesktop theme elsewhere), so a config written on a Mac
still makes a sound on Linux. Any path works too.

```toml
[applets.timer.sounds]
done   = "alarm"          # or "bell", or "~/snd/gong.wav", or false for silence
break  = "chime"
work   = "rise"
volume = 0.6
```

`sounds = false` under `[applets.timer]` silences all three. Skipping a phase
by hand is always quiet — you are already at the keyboard — and so is a
countdown you stop yourself. `KONA_SOUND=0` mutes the whole daemon for a
session, and `KONA_SOUND_PLAYER="mpg123 -q"` names the player when this machine
has one kona does not probe for.

## Notifications

`timer.done` (a countdown reaches zero) and `timer.pomodoro` (a phase ends),
both on by default — `kona notify off timer.done` to silence one. The banner
drops its own ding when the cue above is going to play, so one ending is one
sound; turn the banners off and the sounds keep working, because they are their
own channel and not a decoration on a macOS-only feature.
