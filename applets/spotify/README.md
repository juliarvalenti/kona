# spotify

Now playing, transport control, search, and Spotify Connect devices.

```sh
kona login spotify
kona spotify
kona call spotify playPause '{}'
kona call spotify queue '{"q":"four tet rave green"}'   # free text, resolved
kona call spotify volume '{"pct":40}'
kona call spotify transfer '{"name":"kitchen"}'
```

On the now-playing screen the applet claims `←`/`→` to scrub (the hint bar says
so); inside a list they go back to being navigation. `space` plays/pauses, `d`
opens the device picker, `/` searches.

The OAuth token lives in the Keychain. `KONA_FAKE_PROVIDERS=1` makes every Web
API call a no-op — the test suite sets it so a signed-in machine never gets its
real playback hijacked.

## Config

```toml
[applets.spotify]
accent = "#1db954"   # Spotify green
```
