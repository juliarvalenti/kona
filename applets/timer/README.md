# timer

Countdowns and a pomodoro cycle, in the daemon — so they keep running with no
terminal open, and finish with a desktop banner.

```sh
kona timer 5m                                # open it, pre-started
kona timer pomodoro                          # ...or a 25/5 work-break cycle
kona call timer start '{"seconds":300,"label":"tea"}'
kona call timer pause '{"id":"t1"}'          # id, label or index — your pick
kona state timer
```

Several countdowns run at once; `1`/`2`/`3` start the presets, `space` pauses
the selected one, `x` stops it and `c` clears the finished ones.

## Pomodoro

The pomodoro cycle — work → short break → … → long break — runs *alongside* the
plain countdowns, not instead of them. Each phase counts down in the daemon,
hands itself to the next one, and banners the desktop on the way past
(`timer.pomodoro`, toggleable on its own). The view shows the phase, the round
you're on and how many you've banked today.

```sh
kona timer pomodoro                                  # or `p` in the TUI
kona call timer pomodoro.start '{"work":"50m","short":"10m"}'
kona call timer pomodoro.skip '{}'                   # "skip this break"
kona call timer pomodoro.pause '{}'                  # ...and .resume/.toggle/.stop
```

In the TUI: `p` starts a session and pauses/resumes it, `n` skips the current
phase, `x` ends the session.

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

## Notifications

`timer.done` (a countdown reaches zero) and `timer.pomodoro` (a phase ends),
both on by default — `kona notify off timer.done` to silence one.
