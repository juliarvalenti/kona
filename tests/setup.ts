// Test preload — runs before any test file (see bunfig.toml `[test] preload`).
//
// Puts every external provider behind the transport seam in `server/transport.ts`:
// with this set, a provider call that would leave the machine throws instead,
// naming itself and how to fake it. Nothing in the suite can touch a real
// account, signed in or not, online or off.
//
// This exists because the daemon/applet tests boot a real konad that loads every
// applet: spotify's init/tick call the live Web API, and its verbs perform real
// playback (seek/volume/transfer). On a signed-in machine a plain `bun test`
// therefore hijacked the user's actual Spotify (#41).
//
// A test that WANTS provider data installs a fake — `fakeProviders()` from
// `sdk/fake.ts`, with fixtures from `tests/fixtures/` — or points the provider's
// `*_API` env at a fixture server it started on localhost. The real thing is
// reachable only from a `*.live.test.ts` that calls `allowLive()` under
// `KONA_LIVE=1`, which the default run skips.
process.env.KONA_FAKE_PROVIDERS = "1";

// Hermetic applet set: the suite loads whatever is in `applets/`, never the
// plugins a developer happens to have installed under ~/.config/kona/plugins
// (a foreign applet would change the launcher, the manifest and the skill).
// A loader test that WANTS plugins clears this itself.
process.env.KONA_NO_PLUGINS = "1";
