# webex

Your Webex spaces in the terminal: the list newest-first with an unread dot, `→`
to drill into one, and `c` to write back.

Sign in either way — a personal access token gets you looking around in a
minute, an OAuth integration keeps the daemon signed in:

```sh
kona login webex     # OAuth if ~/.config/kona/webex.json has a client, else
                     # it asks for a personal token (developer.webex.com)
```

```jsonc
// ~/.config/kona/webex.json — one or the other
{ "client_id": "...", "client_secret": "..." }   // OAuth integration
{ "token": "..." }                               // personal access token
```

An OAuth integration wants the redirect URI `http://127.0.0.1:8898/callback` and
the scopes `spark:rooms_read spark:messages_read spark:messages_write
spark:people_read`. Either credential ends up in the Keychain, never on disk;
`KONA_WEBEX_TOKEN` overrides both for a script.

Posting is the bimodal seam at its plainest — `post` is one verb with two
callers:

```sh
kona call webex post '{"space":"ship-kona","text":"deploy is green"}'
```

is exactly what pressing `c`, typing, and hitting enter does. `a` marks every
space read; agents call `webex.read '{"all":true}'`. Webex has no unread count
of its own, so kona keeps read receipts per space in
`~/.local/state/kona/webex-seen.json` — opening a space marks it read, and the
dash shows how many are still waiting.

## Config

```toml
[applets.webex]
accent = "#3b82f6"
spaces = 25   # how many spaces to list
page   = 30   # messages per space
```

## Notifications

`webex.message` — a space gets new messages. Off by default.
