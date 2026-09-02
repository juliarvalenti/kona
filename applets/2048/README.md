# 2048

Slide the board, merge the pairs, chase the 2048 tile. The turn-based one — so
it is the game an **agent** can genuinely play.

```sh
kona 2048                          # open it
kona call 2048 left                # ...and the same move, over HTTP
kona state 2048                    # the grid, the score, the status
```

`↑↓←→` or `wasd` slide, `n` deals a new board, `.` lets the applet play one
move for you.

## Why this one is bimodal and snake isn't

A real-time game moves whether or not anyone is reading it: by the time an
agent has fetched a frame, the tick has moved on. 2048 has no tick. The world
moves **only when a move is made**, so the grid you read is the grid you are
answering — there is no staleness to design around, and no pacing mode to
configure.

```sh
kona call 2048 newGame '{"seed":7}'   # same seed, same game, every time
kona call 2048 left                   # -> { moved, gained, status }
kona call 2048 down
```

A move that changes nothing comes back `moved: false` and costs no turn: no
tile spawns and the move count doesn't rise. That is the signal to try another
direction rather than the same one again. Every verb is `low` priority —
nothing here leaves the machine, so nothing waits on an approval.

Watch it play itself:

```sh
kona call 2048 auto '{"moves":40}'    # greedy, one move ahead, deterministic
```

Open the applet in the TUI while that runs and the board slides under you.

## Rendering

A `col` of `row`s of `text` cells with background fills, and the score as a
`big` hero — no new primitives. Tile colors are theme ROLES on a heat ramp, so
the board reskins with your palette. The ramp climbs and then stops: eight roles
cannot keep up with a number that keeps doubling, and everything from 128 up is
simply hot.

| key | verb | what it does |
| --- | --- | --- |
| `↑↓←→` / `wasd` | `up`/`down`/`left`/`right` | slide |
| `n` | `newGame` | deal a new board (the high score stays) |
| `.` | `auto` | let the applet play one move |

## Config

The id is all digits, so TOML wants it quoted:

```toml
[applets."2048"]
goal = 2048   # the tile that wins it; the board plays on either way
```
