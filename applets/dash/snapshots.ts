import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The cockpit with a board full of contributed cards, and the same screen with
 * nothing live anywhere.
 *
 * dash renders only its OWN state — `collectCards()` is what fills `cards` in
 * from the other applets — so a fixture is just the picture, no peeking
 * required. Each row here is what some applet's `dash(state)` returned.
 */
const CARDS = [
  ["timer", "timer:countdown", "⏲ 12:23  focus  +1 more", "", "#00d488", 65],
  ["email", "email", "✉ 6 unread  ·  Ada Lovelace: re: the analytical engine", "9:14a", "#00d488", 50],
  ["spotify", "spotify", "♪ Rave Green — Sounders FC", "▶ ⤮", "#1db954", 45],
  ["mycelium", "mycelium", "❂ 2 rooms active  ·  ship-kona, triage", "now", "#00d4b4", 40],
  ["workflows", "workflows:next", "⚙ next “morning” in 47m", "", "#bb9af7", 30],
  ["weather", "weather", "☀ 68°F  Mainly clear  ·  Seattle", "", "#f0b000", 5],
] as const;

const GH = [
  ["PullRequest", "applet screenshots in the README", "juliarvalenti/kona", "2h"],
  ["Issue", "provider mocks for the test suite", "juliarvalenti/kona", "5h"],
  ["PullRequest", "email: the write side", "juliarvalenti/kona", "1d"],
  ["Issue", "kona new <id> should scaffold a plugin too", "juliarvalenti/kona", "2d"],
] as const;

export default defineSnapshots([
  {
    name: "the cockpit: one card per applet with something live, urgent first",
    hero: true,
    state: () => ({
      cards: CARDS.map(([applet, key, text, note, color, priority]) => ({
        applet,
        key,
        text,
        note,
        color,
        priority,
        navigate: applet,
      })),
      gh: GH.map(([type, title, repo, age]) => ({ type, title, repo, age, url: `https://github.com/${repo}` })),
      cursor: 0,
    }),
    width: 84,
    height: 24,
    contains: [
      "⏲ 12:23",
      "6 unread",
      "Rave Green",
      "2 rooms active",
      "next “morning” in 47m",
      "Mainly clear",
      "GITHUB",
      "applet screenshots in the README",
    ],
  },
  {
    name: "nothing live anywhere says so, instead of a column of zeroes",
    width: 76,
    height: 16,
    contains: ["all quiet", "nothing needs you right now"],
    excludes: ["GITHUB", "0 unread"],
  },
]);
