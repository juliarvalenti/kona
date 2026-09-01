# dash

The live cockpit: now playing, the running timer, unread mail and the GitHub
items involving you — one screen, meant to be left open.

It composes the OTHER applets rather than fetching for itself: every applet's
tick runs in the daemon whether or not it's on screen, so `dash` reads their
state through `peek()` and adds only its own GitHub poll.

```sh
kona dash
kona call dash refresh '{}'
kona call dash open '{"index":0}'   # open a PR/issue, or jump to Spotify
```

## Config

```toml
[applets.dash]
accent = "#1db954"
```

## Notifications

`github.new` — a PR or issue involving you shows up. On by default.
