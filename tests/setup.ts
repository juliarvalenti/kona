// Test preload — runs before any test file (see bunfig.toml `[test] preload`).
//
// Forces external providers into a no-live-call mode for the whole suite. This
// exists because the daemon/applet tests boot a real konad that loads every
// applet: spotify's init/tick call the live Web API, and its verbs perform real
// playback (seek/volume/transfer). On a signed-in machine a plain `bun test`
// therefore hijacked the user's actual Spotify. Setting this here, before the
// server modules load, makes `server/spotify.ts`'s api() no-op in tests.
//
// This is the stopgap; the real provider mock layer is tracked in #41.
process.env.KONA_FAKE_PROVIDERS = "1";

// Hermetic applet set: the suite loads whatever is in `applets/`, never the
// plugins a developer happens to have installed under ~/.config/kona/plugins
// (a foreign applet would change the launcher, the manifest and the skill).
// A loader test that WANTS plugins clears this itself.
process.env.KONA_NO_PLUGINS = "1";
