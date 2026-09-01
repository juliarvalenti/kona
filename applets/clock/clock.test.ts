import { test, expect } from "bun:test";
import type { AppletCtx, ViewNode } from "../../sdk/index.ts";
import clock from "./index.ts";

/**
 * The clock applet is a pure reducer plus a pure projection of one timestamp.
 * Every reading derives from `state.now`, so these tests pin a fixed instant
 * and get the same answers forever — no sleeping, no real clock.
 *
 * Day-delta chips are relative to the MACHINE's day, so pin that too.
 */
process.env.TZ = "UTC";

// 2026-09-01T16:00:45Z — a Tuesday in UTC, already Wednesday in Tokyo.
const NOW = Date.parse("2026-09-01T16:00:45Z");

type ClockState = typeof clock.initialState;

function harness(overrides: Partial<ClockState> = {}) {
  const state: ClockState = { ...structuredClone(clock.initialState), now: NOW, ...overrides };
  let emits = 0;
  const ctx: AppletCtx<ClockState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => clock.verbs[verb]!(args, ctx) as any,
    tick: () => clock.tick!(ctx),
  };
}

function flatten(nodes: ReturnType<typeof clock.view>): Array<Exclude<ViewNode, string>> {
  const out: Array<Exclude<ViewNode, string>> = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return;
    out.push(n);
    if (n.kind === "row" || n.kind === "col") n.children.forEach(visit);
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(visit);
  return out;
}
const textOf = (nodes: ReturnType<typeof clock.view>) =>
  flatten(nodes)
    .filter((n) => n.kind === "text")
    .map((n) => (n as { text: string }).text);

test("seeds a board and reads every zone off one instant", () => {
  const h = harness();
  const { zones } = h.call("list");
  expect(zones.map((z: { label: string }) => z.label)).toEqual([
    "San Francisco",
    "New York",
    "London",
    "Berlin",
    "Tokyo",
  ]);
  expect(zones[0]).toMatchObject({ time: "09:00", offset: "UTC-7", dayDelta: 0 });
  expect(zones[4]).toMatchObject({ time: "01:00", offset: "UTC+9", dayDelta: 1 });
  expect(h.emits()).toBe(0); // list is a read — it never touches state
});

test("list reads a zone that isn't on the board (half-hour offsets included)", () => {
  const h = harness();
  expect(h.call("list", { tz: "Asia/Kathmandu" }).zones[0]).toMatchObject({
    label: "Kathmandu",
    time: "21:45",
    offset: "UTC+5:45",
  });
  expect(h.call("list", { city: "Bengaluru" }).zones[0]).toMatchObject({ offset: "UTC+5:30" });
  expect(h.state.zones).toHaveLength(5); // still a read
});

test("add resolves catalog cities, raw zones, and refuses nonsense", () => {
  const h = harness({ zones: [] });
  h.call("add", { city: "tokyo" }); // case-insensitive catalog hit
  h.call("add", { tz: "Antarctica/Troll" }); // raw IANA id, label derived
  h.call("add", { city: "Hong" }); // prefix match
  expect(h.state.zones.map((z) => z.label)).toEqual(["Tokyo", "Troll", "Hong Kong"]);
  expect(h.state.cursor).toBe(2); // selection follows the newest zone

  expect(h.call("add", { city: "Atlantis" })).toMatchObject({ error: expect.stringContaining("Atlantis") });
  expect(h.state.zones).toHaveLength(3);
});

test("add is idempotent — a zone already on the board just gets selected", () => {
  const h = harness();
  const res = h.call("add", { city: "London" });
  expect(res).toMatchObject({ added: null, zones: 5 });
  expect(h.state.cursor).toBe(2);
});

test("remove takes a name, an index, or the cursor, and clamps", () => {
  const h = harness({ cursor: 4 });
  expect(h.call("remove", { city: "berlin" }).removed).toMatchObject({ label: "Berlin" });
  h.call("remove", { index: 0 });
  expect(h.state.zones.map((z) => z.label)).toEqual(["New York", "London", "Tokyo"]);
  h.call("remove"); // the cursor's zone (clamped to the last)
  expect(h.state.zones.map((z) => z.label)).toEqual(["New York", "London"]);
  expect(h.state.cursor).toBe(1);
  expect(h.call("remove", { city: "Kyiv" })).toMatchObject({ error: "no such zone" });
});

test("sort hangs the wall west -> east and keeps your selection", () => {
  const h = harness({ cursor: 4 }); // Tokyo
  h.call("sort");
  expect(h.state.zones.map((z) => z.label)).toEqual([
    "San Francisco",
    "New York",
    "London",
    "Berlin",
    "Tokyo",
  ]);
  h.call("add", { city: "Auckland" });
  h.call("add", { city: "Honolulu" });
  h.state.cursor = 0; // San Francisco
  h.call("sort");
  expect(h.state.zones.map((z) => z.label)).toEqual([
    "Honolulu",
    "San Francisco",
    "New York",
    "London",
    "Berlin",
    "Tokyo",
    "Auckland",
  ]);
  expect(h.state.zones[h.state.cursor]!.label).toBe("San Francisco");
});

test("format flips 12/24h and can be set outright", () => {
  const h = harness();
  h.call("format");
  expect(h.state.hour12).toBe(true);
  expect(h.call("list").zones[0]).toMatchObject({ time: "9:00 AM" });
  expect(h.call("list").zones[4]).toMatchObject({ time: "1:00 AM" });
  h.call("format", { hour12: false });
  expect(h.state.hour12).toBe(false);
});

test("the picker filters the catalog and choose adds the highlighted city", () => {
  const h = harness({ zones: [] });
  h.call("find", { q: "japan" });
  expect(h.state).toMatchObject({ picker: true, query: "japan", pick: 0 });
  h.call("choose");
  expect(h.state.zones.map((z) => z.label)).toEqual(["Tokyo"]);
  expect(h.state).toMatchObject({ picker: false, query: "" }); // adding closes it

  // no match -> nothing to add, board untouched
  h.call("find", { q: "narnia" });
  expect(h.call("choose")).toMatchObject({ error: "nothing to add" });
  h.call("close");
  expect(h.state).toMatchObject({ picker: false, query: "", pick: 0 });
});

test("up/down drive the picker when it's open and the board when it isn't", () => {
  const h = harness();
  h.call("down");
  h.call("down");
  expect(h.state.cursor).toBe(2);
  h.call("up");
  expect(h.state.cursor).toBe(1);
  for (let i = 0; i < 10; i++) h.call("up");
  expect(h.state.cursor).toBe(0); // clamped, never negative

  h.call("find", { q: "india" }); // Bengaluru, Mumbai
  h.call("down");
  expect(h.state).toMatchObject({ pick: 1, cursor: 0 }); // the board cursor stays put
  h.call("down");
  expect(h.state.pick).toBe(1); // clamped to the last match
  h.call("choose");
  expect(h.state.zones.at(-1)!.label).toBe("Mumbai");
});

test("choose on the board opens the picker (-> is 'add')", () => {
  const h = harness();
  expect(h.call("choose")).toMatchObject({ picker: true });
  expect(h.state.zones).toHaveLength(5);
});

test("tick restamps now so every clock on the board advances together", () => {
  const h = harness({ now: 0 });
  const before = Date.now();
  h.tick();
  expect(h.state.now).toBeGreaterThanOrEqual(before);
  expect(h.emits()).toBe(1);
});

test("view renders a hero for the selection and a row per zone", () => {
  const h = harness({ cursor: 4 }); // Tokyo
  const nodes = clock.view(h.state, { width: 72, height: 24 });
  const hero = flatten(nodes).find((n) => n.kind === "big");
  expect(hero).toMatchObject({ kind: "big", text: "01:00" });

  const lines = textOf(nodes);
  expect(lines.some((l) => l.includes("Tokyo") && l.includes("Wed 2 Sep") && l.includes("(+1d)"))).toBe(true);
  for (const city of ["San Francisco", "New York", "London", "Berlin", "Tokyo"]) {
    expect(lines.some((l) => l.includes(city))).toBe(true);
  }
  // the selected row is the highlight bar, not a plain row
  const selected = flatten(nodes).find((n) => n.kind === "text" && n.focus);
  expect((selected as { text: string }).text).toContain("Tokyo");
});

test("view shows the catalog while the picker is open", () => {
  const h = harness({ picker: true, query: "brazil" });
  const lines = textOf(clock.view(h.state, { width: 72, height: 24 }));
  expect(lines.some((l) => l.includes("add a city"))).toBe(true);
  expect(lines.some((l) => l.includes("São Paulo"))).toBe(true);
  expect(lines.some((l) => l.includes("Tokyo"))).toBe(false); // filtered out
});

test("view offers a way in when the board is empty", () => {
  const lines = textOf(clock.view(harness({ zones: [] }).state, { width: 60, height: 20 }));
  expect(lines.some((l) => l.includes("no zones"))).toBe(true);
  expect(lines.some((l) => l.includes("clock add"))).toBe(true);
});

test("accent tints the frame by the selected city's time of day", () => {
  const night = harness({ cursor: 4 }); // Tokyo, 01:00
  expect(clock.accent!(night.state)).toBe("#7aa2f7");
  const day = harness({ cursor: 1 }); // New York, 12:00
  expect(clock.accent!(day.state)).toBe("#00d488");
  const morning = harness({ cursor: 0 }); // San Francisco, 09:00
  expect(clock.accent!(morning.state)).toBe("#f0b000");
  const evening = harness({ cursor: 3 }); // Berlin, 18:00
  expect(clock.accent!(evening.state)).toBe("#bb9af7");
  expect(clock.accent!(harness({ zones: [] }).state)).toBe("#6a6a6a");
});
