/**
 * Recorded Spotify Web API payloads, trimmed to the fields kona reads.
 *
 * These are the shapes a real account answers with — one paused track on a
 * laptop, a queue behind it, two Connect devices, a search that returns one of
 * each kind. A test drives the real verbs against them, so the parsing in
 * `server/spotify.ts` is exercised end to end without an account:
 *
 *   const fake = fakeProviders(spotifyRoutes());
 *   await spotify.verbs.refresh!({}, ctx);
 *
 * The write endpoints (play/pause/seek/volume/transfer/queue) are deliberately
 * NOT routed: an unrouted write answers 204 the way Spotify's player endpoints
 * do, and `fake.writes()` is what the test asserts on. That is the whole point
 * of #41 — the command is recorded, never sent.
 */

export const TRACK_URI = "spotify:track:2Fs2VfRfXQP4pFbLNZfBBB";
export const PLAYLIST_URI = "spotify:playlist:37i9dQZF1DX4JAvHpjipBk";
export const LAPTOP_ID = "0d1841b0976bae2a3a310dd74c0f3df354899bc8";
export const SPEAKER_ID = "5fbb3ba6aa454b5534c4ba43a8c7e8e45a63ad0e";

const artist = (id: string, name: string) => ({ id, name, uri: `spotify:artist:${id}`, type: "artist" });

/** The item + album shape every track endpoint returns. */
export const rave = {
  id: "2Fs2VfRfXQP4pFbLNZfBBB",
  name: "Rave Green",
  uri: TRACK_URI,
  duration_ms: 214_000,
  artists: [artist("7Eu5hfWBrJ3xU7VDphE4mv", "Four Tet")],
  album: { id: "1YZ3k65Mqw3G8FzYlW1mmp", name: "Sixteen Oceans", uri: "spotify:album:1YZ3k65Mqw3G8FzYlW1mmp" },
};

const baby = {
  id: "6habFhsOp2NvshLv26DqMb",
  name: "Baby",
  uri: "spotify:track:6habFhsOp2NvshLv26DqMb",
  duration_ms: 191_000,
  artists: [artist("7Eu5hfWBrJ3xU7VDphE4mv", "Four Tet")],
  album: { id: "1YZ3k65Mqw3G8FzYlW1mmp", name: "Sixteen Oceans", uri: "spotify:album:1YZ3k65Mqw3G8FzYlW1mmp" },
};

/** GET /v1/me/player — paused, on the laptop, inside a playlist. */
export const player = {
  device: { id: LAPTOP_ID, name: "MacBook Pro", type: "Computer", is_active: true, volume_percent: 62, supports_volume: true },
  shuffle_state: false,
  repeat_state: "off" as const,
  context: { uri: PLAYLIST_URI, type: "playlist" },
  progress_ms: 41_000,
  is_playing: false,
  item: rave,
};

/** GET /v1/me/player/queue */
export const queue = { currently_playing: rave, queue: [baby] };

/** GET /v1/me/player/devices — the laptop it is on, and one to hand off to. */
export const devices = {
  devices: [
    { id: LAPTOP_ID, name: "MacBook Pro", type: "Computer", is_active: true, volume_percent: 62, supports_volume: true },
    { id: SPEAKER_ID, name: "Kitchen Speaker", type: "Speaker", is_active: false, volume_percent: 100, supports_volume: false },
    { id: null, name: "Restricted TV", type: "TV", is_active: false }, // no id — kona drops these
  ],
};

/** GET /v1/search?type=artist,album,track,playlist */
export const search = {
  artists: { items: [{ ...artist("7Eu5hfWBrJ3xU7VDphE4mv", "Four Tet"), genres: ["electronic", "idm"] }] },
  playlists: { items: [{ id: "37i9dQZF1DX4JAvHpjipBk", name: "Four Tet Radio", uri: PLAYLIST_URI, owner: { display_name: "Spotify" } }] },
  albums: { items: [{ id: "1YZ3k65Mqw3G8FzYlW1mmp", name: "Sixteen Oceans", uri: "spotify:album:1YZ3k65Mqw3G8FzYlW1mmp", artists: [artist("7Eu5hfWBrJ3xU7VDphE4mv", "Four Tet")] }] },
  tracks: { total: 42, items: [rave, baby] },
};

/** GET /v1/playlists/{id} */
export const playlist = {
  id: "37i9dQZF1DX4JAvHpjipBk",
  name: "Four Tet Radio",
  uri: PLAYLIST_URI,
  tracks: { items: [{ track: rave }, { track: baby }] },
};

/** GET /v1/albums/{id} */
export const album = {
  id: "1YZ3k65Mqw3G8FzYlW1mmp",
  name: "Sixteen Oceans",
  uri: "spotify:album:1YZ3k65Mqw3G8FzYlW1mmp",
  tracks: { items: [rave, baby] },
};

/** The routes an applet test installs — every read kona makes, answered. */
export function spotifyRoutes() {
  return {
    "GET /v1/me": { id: "kona", display_name: "Kona Tester", country: "US" },
    "GET /v1/me/player": player,
    "GET /v1/me/player/queue": queue,
    "GET /v1/me/player/devices": devices,
    "GET /v1/me/player/recently-played": { items: [{ track: rave, played_at: new Date(Date.now() - 3_600_000).toISOString() }] },
    "GET /v1/me/top/artists": { items: [{ ...artist("7Eu5hfWBrJ3xU7VDphE4mv", "Four Tet"), genres: ["electronic"] }] },
    "GET /v1/me/playlists": { items: [{ id: "37i9dQZF1DX4JAvHpjipBk", name: "Four Tet Radio", uri: PLAYLIST_URI, owner: { display_name: "Spotify" } }] },
    "GET /v1/search": search,
    "GET /v1/playlists/*": playlist,
    "GET /v1/albums/*": album,
    "GET /v1/artists/*": (call: { path: string }) =>
      call.path.includes("/albums")
        ? { items: [{ id: "1YZ3k65Mqw3G8FzYlW1mmp", name: "Sixteen Oceans", uri: "spotify:album:1YZ3k65Mqw3G8FzYlW1mmp", release_date: "2020-03-13" }] }
        : call.path.includes("/top-tracks")
          ? { tracks: [rave, baby] }
          : { id: "7Eu5hfWBrJ3xU7VDphE4mv", name: "Four Tet", uri: "spotify:artist:7Eu5hfWBrJ3xU7VDphE4mv" },
  };
}
