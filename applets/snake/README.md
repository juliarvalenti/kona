# snake

The C64 classic, in the daemon. `LOAD"SNAKE",8,1` — then eat, grow, and don't
bite yourself.

```sh
kona snake                              # open it (it loads off tape first)
kona state snake                        # the board, the food and the score
kona call snake turn '{"dir":"up"}'     # what the arrow keys do
```

`↑↓←→` or `wasd` steer, `space` starts and pauses, `n` deals a new board. `esc`
pauses a running game rather than leaving it — walking away from a moving snake
is how you come back to a dead one — so press it twice to get out.

Walls kill and the snake gets faster every five apples. The high score is
ordinary applet state, and applet state is persisted, so it outlives the daemon.

## The board is not a new primitive

It is a `col` of `row`s of colored `text` cells — `██` for the head, `▓▓` for
the body, `◆◆` for supper — and the score is a `big` hero. Every color is a
theme role, so snake reskins with your palette and re-letters with your figlet
like everything else in kona.

## Playing it as an agent

A real-time game does not travel over HTTP: by the time you have read a frame,
the tick has moved the world. So pause it first. A paused game keeps its board
and still answers `step`, which advances exactly one frame — real-time for a
human, turn-by-turn for you.

```sh
kona call snake newGame '{"seed":7}'    # same seed, same game, every time
kona call snake pause '{}'
kona call snake turn '{"dir":"up"}'     # a paused game stays paused
kona call snake step '{}'               # -> { head, food, score, status }
```

Every verb is `low` priority: nothing here leaves the machine, so nothing waits
on an approval.

| key | verb | what it does |
| --- | --- | --- |
| `↑↓←→` / `wasd` | `turn` | steer |
| `space` | `toggle` | start, or pause |
| `esc` | `back` | pause a running game (again to leave) |
| `n` | `newGame` | a fresh board, keeping the high score |

## Config

```toml
[applets.snake]
walls = true       # false wraps the board edge to edge instead of killing you
speed = "classic"  # "slow" | "classic" | "fast"
```
