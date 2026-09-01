import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The cockpit with everything lit, and the same screen with nothing connected.
 *
 * dash renders only its OWN state — `aggregate()` is what fills that in from
 * the other applets — so a fixture is just the picture, no peeking required.
 */
const GH = [
  ["PullRequest", "applet screenshots in the README", "juliarvalenti/kona", "2h"],
  ["Issue", "provider mocks for the test suite", "juliarvalenti/kona", "5h"],
  ["PullRequest", "email: the write side", "juliarvalenti/kona", "1d"],
  ["Issue", "kona new <id> should scaffold a plugin too", "juliarvalenti/kona", "2d"],
] as const;

export default defineSnapshots([
  {
    name: "the cockpit: song, countdown, mail, spaces, workflows, GitHub",
    hero: true,
    state: () => ({
      np: { track: "Rave Green", artist: "Sounders FC", playing: true, shuffle: true },
      timer: { remaining: 743, running: true, label: "focus", more: 1 },
      emailAuthed: true,
      unread: 6,
      webex: { unread: 2, spaces: 14 },
      flows: {
        defined: 3,
        scheduled: 2,
        next: { name: "morning", at: Date.now() + 47 * 60_000 },
        last: { name: "triage", ok: true, at: Date.now() - 20 * 60_000 },
      },
      gh: GH.map(([type, title, repo, age]) => ({ type, title, repo, age, url: `https://github.com/${repo}` })),
      cursor: 0,
    }),
    width: 84,
    height: 22,
    contains: [
      "Rave Green", "⏲ 12:23", "focus", "+1 more",
      "6 unread",
      "2 spaces with new messages",
      "next “morning” in 47m", "last ✓ triage",
      "GITHUB", "applet screenshots in the README",
    ],
  },
  {
    name: "with nothing connected it is a list of what to connect",
    width: 76,
    height: 16,
    contains: ["nothing playing", "mail not connected", "nothing open involving you"],
  },
]);
