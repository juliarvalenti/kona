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

## Presence

Webex tells the People API who is around, on the scope the applet already asks
for, so the space list says it too: `●` next to a 1:1 means they are at their
keyboard, `○` means they are not — with `seen 12m` for how long it has been.
Open the space and the header spells it out ("last seen 12m ago"), and in a
group the same dot rides beside whoever wrote each message.

```sh
kona call webex presence '{"person":"Grace Hopper"}'
# -> { person: "Grace Hopper", status: "active", lastSeen: "2m" }
kona call webex presence     # everyone we are watching, and how many are active
```

It is deliberately coarse. Webex only reports presence inside your own
organisation, a person can turn status sharing off, and the rich states (in a
call, do not disturb) need the real-time SDK rather than REST — so anything we
can't stand behind draws no dot at all and answers `unknown`. Never an error:
a Webex that won't talk about people costs you the dots and nothing else.

## Config

```toml
[applets.webex]
accent = "#3b82f6"
spaces = 25   # how many spaces to list
page   = 30   # messages per space
```

## Notifications

`webex.message` — a space gets new messages. Off by default.
