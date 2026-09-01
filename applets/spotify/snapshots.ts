import { defineSnapshots } from "../../sdk/testing.ts";

/** Now-playing, the device picker, and who owns ←/→ on each screen. */
export default defineSnapshots([
  {
    name: "now-playing shows track, times, and state",
    state: {
      authed: true,
      playing: true,
      track: "Rave Green",
      artist: "Sounders FC",
      album: "Anthems",
      positionMs: 78000,
      durationMs: 214000,
      device: "MacBook",
    },
    width: 76,
    height: 18,
    contains: [
      "Rave Green", "Sounders FC",
      "1:18", // position
      "3:34", // duration
      "▶", // playing indicator
    ],
  },
  {
    name: "now-playing shows the active device and its volume",
    hero: true, // the fullest now-playing frame: track, scrubber, device, volume
    state: {
      authed: true,
      playing: true,
      track: "Rave Green",
      positionMs: 78000,
      durationMs: 214000,
      device: "MacBook Pro",
      volumePct: 65,
      volumeSupported: true,
    },
    width: 80,
    height: 20,
    // ←/→ scrub here (the applet claims them), so the hint bar says so and
    // offers enter for select instead of →.
    contains: ["MacBook Pro", "vol 65%", "seek", "enter open/play"],
  },
  {
    name: "device picker lists devices and marks the active one",
    state: {
      authed: true,
      mode: "browse",
      stack: [
        {
          title: "Devices",
          cursor: 0,
          rows: [
            { kind: "device", id: "d1", name: "MacBook Pro", subtitle: "Computer  ·  65%", active: true },
            { kind: "device", id: "d2", name: "Living Room", subtitle: "Speaker  ·  30%", active: false },
          ],
        },
      ],
    },
    width: 80,
    height: 20,
    // In a list ←/→ go back to being navigation — no seek hint.
    contains: ["Devices", "MacBook Pro", "● active", "Living Room", "←/esc back"],
    excludes: ["seek"],
  },
]);
