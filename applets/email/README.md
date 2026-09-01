# email

Gmail and Outlook in one list. `server/mail.ts` defines a `MailProvider` (list
an inbox, open a thread) that both implement, and the applet only ever talks to
that seam. Connect as many mailboxes as you like — they merge into ONE inbox,
newest first, each row badged with the account it came from.

```sh
kona login gmail             # Google OAuth, read-only
kona login outlook           # Microsoft Graph, read-only
kona accounts                # what's connected
kona logout gmail ada@x.com  # drop one mailbox (omit the address for all)
```

Each account's refresh token goes to the macOS Keychain (service `kona-gmail` /
`kona-outlook`, account = the address); mail itself never touches disk. A token
stored by an older kona keeps working as-is.

In the TUI, `a` cycles the list between the unified inbox and one account at a
time. Agents get the same seam:

```sh
kona call email accounts '{}'
kona call email account '{"id":"outlook"}'          # scope the list
kona call email search '{"q":"is:unread from:github"}'
kona call email open '{"account":"ada@x.com","id":"18f..."}'
```

Gmail's query syntax is the lingua franca: the Outlook provider translates
`from:`, `subject:`, `is:unread` and `has:attachment` into Graph's
`$search`/`$filter`.

**Google client.** Create a Desktop OAuth client, enable the Gmail API, and save
the JSON to `~/.config/kona/google.json` (or set `KONA_GOOGLE_CLIENT_ID` /
`KONA_GOOGLE_CLIENT_SECRET`).

**Microsoft client.** Register an app in Azure → App registrations, add the
redirect URI `http://127.0.0.1:8897/callback` under *Mobile and desktop
applications*, grant the delegated Graph permissions `Mail.Read`,
`offline_access` and `User.Read`, then save `{"client_id":"..."}` to
`~/.config/kona/microsoft.json` (or set `KONA_MICROSOFT_CLIENT_ID`;
`KONA_MICROSOFT_TENANT` pins a tenant, default `common`, and
`KONA_MICROSOFT_PORT` moves the loopback port). It's a public client — there is
no secret to keep.

For best HTML-email rendering, install a text renderer (the same ones aerc/mutt
use); kona picks the first available, else falls back to a JS converter:

```sh
brew install w3m     # or: pandoc / lynx / elinks
```

## Config

```toml
[applets.email]
page = 20    # threads per fetch
```

## Notifications

`email.unread` — unread mail arrives. Off by default.
