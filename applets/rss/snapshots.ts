import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The river, one item open, and the two states that need no feed list. The
 * fixtures build their timestamps from `Date.now()` so the "3h" column reads
 * the same whenever the suite runs.
 */
const HOUR = 3_600_000;

const ITEMS = [
  ["Hacker News", "Show HN: kona — bimodal terminal applets", 0.4],
  ["lobste.rs", "A plain-text protocol is still a protocol", 2],
  ["xkcd", "Standards", 5],
  ["Hacker News", "Ask HN: what killed your side project?", 9],
  ["Julia Evans", "How I debug a terminal that eats my keys", 26],
  ["lobste.rs", "Writing a TUI without a framework", 31],
] as const;

const river = () => ({
  configured: true,
  feeds: 4,
  syncedAt: Date.now() - 4 * 60_000,
  items: ITEMS.map(([feed, title, hours], i) => ({
    id: `i${i}`,
    feed,
    title,
    link: `https://example.com/${i}`,
    author: "",
    published: Date.now() - hours * HOUR,
    summary: "",
  })),
  read: ["i2", "i4", "i5"],
});

export default defineSnapshots([
  {
    name: "the river: every feed merged, newest first, unread lit",
    hero: true,
    state: river,
    width: 84,
    height: 20,
    contains: [
      "4 feeds",
      "Show HN: kona — bimodal terminal applets",
      "Hacker News", "xkcd",
      "●", // unread marker
      "5h", // relative age column
    ],
  },
  {
    name: "opening an item reads it in place",
    state: () => {
      const s = river();
      return {
        ...s,
        open: { ...s.items[0]!, author: "ada", summary: "An applet is a view you browse\nand verbs an agent calls." },
      };
    },
    width: 84,
    height: 18,
    contains: ["Show HN: kona", "Hacker News", "ada", "verbs an agent calls."],
  },
  {
    name: "with no feed list it shows exactly what to write, and where",
    width: 76,
    height: 20,
    contains: ["No feeds configured", "rss.toml", "[[feeds]]"],
  },
]);
