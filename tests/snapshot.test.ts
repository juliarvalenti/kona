import { test, expect } from "bun:test";
import { snapshot } from "../bin/snapshot.ts";

/**
 * Rendering regression tests. These drive the real stage through OpenTUI's
 * headless renderer and assert on the actual on-screen text — so a layout or
 * component change that breaks the visible output fails here, not in your eyes.
 */

test("launcher lists applets with a cursor and title", async () => {
  const frame = await snapshot("--launcher", undefined, 62, 20);
  expect(frame).toContain("kona");
  expect(frame).toContain("Timer");
  expect(frame).toContain("Storybook");
  expect(frame).toContain("▸"); // cursor marker
});

test("timer shows status, label, and a partly-filled bar", async () => {
  const frame = await snapshot(
    "timer",
    { remaining: 125, total: 300, running: true, label: "tea" },
    62,
    24,
  );
  expect(frame).toContain("running");
  expect(frame).toContain("tea");
  expect(frame).toContain("█"); // bar has fill
  expect(frame).toContain("░"); // ...and empty remainder
});

test("storybook renders every component; bars fill mid-sweep", async () => {
  const frame = await snapshot("storybook", { frame: 45 }, 62, 30);
  for (const expected of ["kona components", "[LIVE]", "host", "inbox", "pause/resume"]) {
    expect(frame).toContain(expected);
  }
  expect(frame).toContain("█"); // progress/gauge have fill at frame 45
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
