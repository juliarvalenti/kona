import { test, expect } from "bun:test";
import { snapshot } from "../bin/snapshot.ts";

/**
 * Rendering regression tests. These drive the real stage through OpenTUI's
 * headless renderer and assert on the actual on-screen text — so a layout or
 * component change that breaks the visible output fails here, not in your eyes.
 */

test("launcher lists applets with a cursor and title", async () => {
  // Tall enough to show the whole launcher list as the applet count grows.
  const frame = await snapshot("--launcher", undefined, 62, 40);
  expect(frame).toContain("kona");
  expect(frame).toContain("Timer");
  expect(frame).toContain("Storybook");
  expect(frame).toContain("▸"); // cursor marker
});

test("timer shows status, label, and a partly-filled bar", async () => {
  const frame = await snapshot(
    "timer",
    { timers: [{ id: "t1", label: "tea", remaining: 125, total: 300, running: true }], cursor: 0 },
    62,
    24,
  );
  expect(frame).toContain("running");
  expect(frame).toContain("tea");
  expect(frame).toContain("█"); // bar has fill
  expect(frame).toContain("░"); // ...and empty remainder
});

test("timer shows the selection big and the rest as rows with mini bars", async () => {
  const frame = await snapshot(
    "timer",
    {
      timers: [
        { id: "t1", label: "tea", remaining: 125, total: 300, running: true },
        { id: "t2", label: "pasta", remaining: 540, total: 900, running: false },
        { id: "t3", label: "pomodoro", remaining: 0, total: 1500, running: false },
      ],
      cursor: 0,
    },
    62,
    26,
  );
  expect(frame).toContain("3 timers");
  expect(frame).toContain("02:05"); // the selected timer's row
  expect(frame).toContain("09:00"); // ...alongside the others
  expect(frame).toContain("00:00");
  for (const glyph of ["▶", "⏸", "✓"]) expect(frame).toContain(glyph); // running/paused/done
});

test("timer with nothing running points at the presets", async () => {
  const frame = await snapshot("timer", undefined, 62, 14);
  expect(frame).toContain("no timers");
  expect(frame).toContain("5m");
  expect(frame).toContain("25m");
});

test("storybook renders every component; bars fill mid-sweep", async () => {
  // Tall viewport: the gallery is longer than a default terminal, and every
  // component has to be on screen for this to be a real regression test.
  const frame = await snapshot("storybook", { frame: 45 }, 62, 60);
  for (const expected of ["kona components", "[LIVE]", "host", "inbox", "pause/resume"]) {
    expect(frame).toContain(expected);
  }
  expect(frame).toContain("█"); // progress/gauge have fill at frame 45
  // sparkline / tabs / toast / card / modal
  expect(frame).toContain("▁"); // sparkline's low samples
  expect(frame).toContain("drafts"); // tab strip
  expect(frame).toContain("rate limited"); // warn toast
  expect(frame).toContain("─ cpu ─"); // card's titled border
  expect(frame).toContain("press m"); // the modal lives on the overlay layer
  expect(frame).not.toContain("╔"); // ...so it is NOT drawn inline in the gallery
});

test("storybook's modal floats over the gallery as an overlay", async () => {
  const frame = await snapshot("storybook", { frame: 45, confirm: true }, 62, 30);
  expect(frame).toContain("delete draft?"); // double-bordered dialog, centered
  expect(frame).toContain("╔");
  expect(frame).not.toContain("[LIVE]"); // scrim covers the body behind it
  expect(frame).toContain("enter delete"); // the overlay owns the hint bar
  expect(frame).toContain("esc cancel");
});

test("storybook's confirm verb leaves a transient toast in the body", async () => {
  const frame = await snapshot("storybook", { frame: 45, note: "draft deleted", noteUntil: 75 }, 62, 30);
  expect(frame).toContain("draft deleted");
  expect(frame).toContain("kona components"); // no overlay: the body is back
});

test("an empty text field shows its placeholder; a filled one shows the value", async () => {
  const empty = await snapshot("storybook", { frame: 0, name: "", editing: false }, 62, 34);
  expect(empty).toContain("type a name…");

  const filled = await snapshot("storybook", { frame: 0, name: "ada", editing: false }, 62, 34);
  expect(filled).toContain("ada");
  expect(filled).toContain("hi, ada!");
  expect(filled).not.toContain("type a name…"); // placeholder yields to the value
});

test("email inbox list shows senders, subjects, and a cursor", async () => {
  const frame = await snapshot(
    "email",
    {
      authed: true,
      cursor: 1,
      threads: [
        { id: "1", from: "GitHub", subject: "PR merged", snippet: "", date: "", unread: true },
        { id: "2", from: "Ada Lovelace", subject: "dinner friday?", snippet: "", date: "", unread: false },
      ],
    },
    80,
    16,
  );
  expect(frame).toContain("GitHub");
  expect(frame).toContain("Ada Lovelace");
  expect(frame).toContain("dinner friday?");
  expect(frame).toContain("●"); // unread dot on the GitHub row
  // (selection is a full-width highlight bar now, not a ▸ marker)
});

test("email reader shows subject, sender, and body", async () => {
  const frame = await snapshot(
    "email",
    {
      authed: true,
      open: {
        id: "2",
        subject: "dinner friday?",
        messages: [{ from: "Ada Lovelace", date: "Mon 18:22", body: "still on for friday?" }],
      },
    },
    80,
    18,
  );
  expect(frame).toContain("dinner friday?");
  expect(frame).toContain("Ada Lovelace");
  expect(frame).toContain("still on for friday?");
});

test("email shows a sign-in prompt when unauthenticated", async () => {
  const frame = await snapshot("email", {}, 72, 14);
  expect(frame).toContain("Not signed in");
  expect(frame).toContain("kona login");
});

test("spotify shows now-playing with track, times, and state", async () => {
  const frame = await snapshot(
    "spotify",
    {
      authed: true,
      playing: true,
      track: "Rave Green",
      artist: "Sounders FC",
      album: "Anthems",
      positionMs: 78000,
      durationMs: 214000,
      device: "MacBook",
    },
    76,
    18,
  );
  expect(frame).toContain("Rave Green");
  expect(frame).toContain("Sounders FC");
  expect(frame).toContain("1:18"); // position
  expect(frame).toContain("3:34"); // duration
  expect(frame).toContain("▶"); // playing indicator
});

test("clock renders a hero time plus a row per zone", async () => {
  // Day-delta chips are relative to the machine's own day — pin it.
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const frame = await snapshot(
      "clock",
      { now: Date.parse("2026-09-01T16:00:45Z"), cursor: 4 },
      72,
      26,
    );
    expect(frame).toContain("San Francisco");
    expect(frame).toContain("UTC-7");
    expect(frame).toContain("Tokyo");
    expect(frame).toContain("UTC+9");
    expect(frame).toContain("+1d"); // Tokyo is already tomorrow
    expect(frame).toContain("Wed 2 Sep"); // hero date line
    expect(frame).toContain("█"); // the block-font hero + seconds bar
  } finally {
    process.env.TZ = tz;
  }
});

test("clock's picker lists matching cities to add", async () => {
  const frame = await snapshot("clock", { now: Date.parse("2026-09-01T16:00:45Z"), picker: true, query: "india" }, 72, 20);
  expect(frame).toContain("add a city");
  expect(frame).toContain("Bengaluru");
  expect(frame).toContain("Mumbai");
  expect(frame).toContain("UTC+5:30");
  expect(frame).not.toContain("Berlin"); // filtered out
});

test("notes lists jotted lines with a header count", async () => {
  const frame = await snapshot(
    "notes",
    {
      cursor: 1,
      notes: [
        { id: "a1", text: "ship the notes applet", at: Date.now() },
        { id: "b2", text: "milk, eggs, coffee", at: Date.now() - 7_200_000 },
      ],
    },
    72,
    16,
  );
  expect(frame).toContain("SCRATCHPAD");
  expect(frame).toContain("2 notes");
  expect(frame).toContain("ship the notes applet");
  expect(frame).toContain("milk, eggs, coffee");
});

test("an empty notes pad shows how to jot the first line", async () => {
  const frame = await snapshot("notes", {}, 72, 14);
  expect(frame).toContain("0 notes");
  expect(frame).toContain("nothing jotted yet");
  expect(frame).toContain("notes.add");
});

test("mycelium lists rooms with agent and message counts", async () => {
  const frame = await snapshot(
    "mycelium",
    {
      source: "cli",
      syncedAt: Date.now(),
      cursor: 0,
      rooms: [
        { id: "ship-kona", name: "ship-kona", topic: "getting v0 out", agents: ["planner", "coder", "critic"], messages: 42, lastAt: Date.now() },
        { id: "research", name: "research", topic: "", agents: ["scout"], messages: 7, lastAt: Date.now() - 3_600_000 },
      ],
    },
    80,
    20,
  );
  expect(frame).toContain("2 rooms");
  expect(frame).toContain("via cli");
  expect(frame).toContain("ship-kona");
  expect(frame).toContain("3 agents");
  expect(frame).toContain("1 agent"); // singular
  expect(frame).toContain("42 msg");
  expect(frame).toContain("●"); // recent chatter marker on ship-kona
});

test("spotify now-playing shows the active device and its volume", async () => {
  const frame = await snapshot(
    "spotify",
    {
      authed: true,
      playing: true,
      track: "Rave Green",
      positionMs: 78000,
      durationMs: 214000,
      device: "MacBook Pro",
      volumePct: 65,
      volumeSupported: true,
    },
    80,
    20,
  );
  expect(frame).toContain("MacBook Pro");
  expect(frame).toContain("vol 65%");
  // ←/→ scrub here (the applet claims them), so the hint bar says so and
  // offers enter for select instead of →.
  expect(frame).toContain("seek");
  expect(frame).toContain("enter open/play");
});

test("spotify device picker lists devices and marks the active one", async () => {
  const frame = await snapshot(
    "spotify",
    {
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
    80,
    20,
  );
  expect(frame).toContain("Devices");
  expect(frame).toContain("MacBook Pro");
  expect(frame).toContain("● active");
  expect(frame).toContain("Living Room");
  // In a list ←/→ go back to being navigation — no seek hint.
  expect(frame).toContain("←/esc back");
  expect(frame).not.toContain("seek");
});

test("mycelium room view shows agents, messages, and shared memory", async () => {
  const frame = await snapshot(
    "mycelium",
    {
      source: "fs",
      open: {
        source: "fs",
        room: { id: "ship-kona", name: "ship-kona", topic: "getting v0 out", agents: ["planner"], messages: 2, lastAt: 0 },
        agents: [{ name: "planner", status: "thinking", lastSeen: 0 }],
        messages: [
          { id: "1", from: "planner", at: Date.now() - 60_000, text: "split the work into two PRs" },
          { id: "2", from: "coder", at: Date.now(), text: "on it" },
        ],
        memory: [{ key: "repo", value: "juliarvalenti/kona", at: 0 }],
      },
    },
    80,
    22,
  );
  expect(frame).toContain("getting v0 out");
  expect(frame).toContain("planner (thinking)"); // status when reported
  expect(frame).toContain("split the work into two PRs");
  expect(frame).toContain("SHARED MEMORY");
  expect(frame).toContain("juliarvalenti/kona");
});

test("mycelium explains how to connect when no backend answered", async () => {
  const frame = await snapshot("mycelium", {}, 76, 16);
  expect(frame).toContain("No coordination layer found");
  expect(frame).toContain("MYCELIUM_URL");
  expect(frame).toContain(".mycelium/rooms");
});

test("sys draws a labeled gauge per metric with a cpu history line", async () => {
  const frame = await snapshot(
    "sys",
    {
      host: "laptop",
      platform: "darwin",
      uptime: 268200,
      cpu: 0.42,
      cores: 8,
      load: [1.24, 0.98, 0.81],
      history: [0.1, 0.3, 0.7, 0.42],
      mem: { used: 10_500_000_000, total: 17_179_869_184 },
      disk: { used: 198_000_000_000, total: 494_384_795_648, mount: "/" },
      battery: { level: 0.87, charging: false, plugged: false, remaining: "3:12" },
      mount: "/",
      sampledAt: 1,
    },
    76,
    24,
  );
  expect(frame).toContain("laptop  ·  darwin  ·  up 3d 2h");
  for (const label of ["CPU", "MEM", "DISK", "BATT"]) expect(frame).toContain(label);
  expect(frame).toContain(" 42%"); // cpu, self-labeled by the meter
  expect(frame).toContain(" 61%"); // memory
  expect(frame).toContain("9.8G / 16.0G");
  expect(frame).toContain("on battery · 3:12 left");
  expect(frame).toContain("█"); // bars have fill
  expect(frame).toContain("░"); // ...and an empty remainder
  expect(frame).toContain("▆"); // the cpu sparkline
});

test("sys dims metrics the machine doesn't have instead of showing an empty gauge", async () => {
  const frame = await snapshot(
    "sys",
    {
      host: "vm",
      platform: "linux",
      uptime: 5400,
      cpu: 0.94,
      cores: 4,
      load: [3.9, 2.1, 1.4],
      history: [0.9, 0.94],
      mem: { used: 15_000_000_000, total: 16_856_133_632 },
      disk: null,
      battery: null,
      mount: "/",
      sampledAt: 1,
    },
    60,
    22,
  );
  expect(frame).toContain("BATT  no battery");
  expect(frame).toContain("DISK  unavailable");
  expect(frame).toContain(" 94%");
});

const TICKER_QUOTES = [
  {
    symbol: "AAPL", name: "Apple Inc.", kind: "equity", currency: "USD",
    price: 316.85, prevClose: 319.7, change: -2.85, changePct: -0.891,
    dayHigh: 321.24, dayLow: 312.8, yearHigh: 344.57, yearLow: 225.95,
    volume: 40667429, open: true, spark: [319, 318, 317.5, 318.2, 316, 315.4, 316.85],
  },
  {
    symbol: "BTC-USD", name: "Bitcoin USD", kind: "crypto", currency: "USD",
    price: 77859.73, prevClose: 78559.11, change: -699.38, changePct: -0.765,
    dayHigh: 79159.34, dayLow: 77932, yearHigh: 126198.07, yearLow: 57747.76,
    volume: 29379194880, open: true, spark: [78732, 78844, 78680, 78377, 78191, 77859.73],
  },
];

test("ticker board lists symbols with price, %chg, and a sparkline", async () => {
  const frame = await snapshot(
    "ticker",
    { symbols: ["AAPL", "BTC-USD", "ETH-USD"], quotes: TICKER_QUOTES, cursor: 0, updatedAt: Date.now() },
    90,
    16,
  );
  expect(frame).toContain("MARKETS");
  expect(frame).toContain("AAPL");
  expect(frame).toContain("Bitcoin USD");
  expect(frame).toContain("77,859.73"); // grouped price
  expect(frame).toContain("-0.89%"); // signed percent change
  expect(frame).toContain("█▆▅▇▂▁▄"); // AAPL's intraday shape, as a sparkline
  expect(frame).toContain("ETH-USD"); // a symbol without a quote yet still gets a row
});

test("ticker detail shows the day's numbers and a wide sparkline", async () => {
  const frame = await snapshot(
    "ticker",
    { symbols: ["BTC-USD"], quotes: TICKER_QUOTES, open: "BTC-USD", updatedAt: Date.now() },
    76,
    22,
  );
  expect(frame).toContain("BTC-USD");
  expect(frame).toContain("crypto");
  expect(frame).toContain("▼"); // down arrow
  expect(frame).toContain("prev close");
  expect(frame).toContain("78,559.11");
  expect(frame).toContain("77,932.00 – 79,159.34"); // day range
  expect(frame).toContain("29B"); // compact volume
});

test("ticker with an empty watchlist explains how to fill it", async () => {
  const frame = await snapshot("ticker", { symbols: [] }, 72, 14);
  expect(frame).toContain("Watchlist empty");
  expect(frame).toContain("ticker.json");
});
