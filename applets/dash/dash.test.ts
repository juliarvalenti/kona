import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApplet, type AnyApplet, type AppletState } from "../../sdk/index.ts";
import { resetConfig } from "../../core/config.ts";
import { collectCards } from "./cards.ts";
import dash from "./index.ts";
import timer from "../timer/index.ts";
import spotify from "../spotify/index.ts";

/**
 * The dash sources its rows from the applets, not from a list it keeps. So the
 * tests are about the CONTRACT: an applet with something live gets a row, an
 * idle one gets nothing, urgency decides the order, and one applet's bad card
 * cannot take the cockpit down.
 */

const dirs: string[] = [];
const prevDir = process.env.KONA_CONFIG_DIR;

/** Point config resolution at a throwaway `[applets.dash]` block. */
function withConfig(toml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "kona-dash-"));
  dirs.push(dir);
  if (toml !== undefined) writeFileSync(join(dir, "config.toml"), toml);
  process.env.KONA_CONFIG_DIR = dir;
  resetConfig();
}

afterEach(() => {
  if (prevDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevDir;
  resetConfig();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway applet whose only interesting field is its card. */
function applet(id: string, dashFn: AnyApplet["dash"], tint = "#111111"): AnyApplet {
  return defineApplet<AppletState>({
    id,
    title: id,
    tint,
    initialState: {},
    verbs: {},
    dash: dashFn,
    view: () => [],
  }) as AnyApplet;
}

const states: Record<string, AppletState> = { loud: {}, quiet: {}, calm: {}, boom: {} };
const peek = (id: string) => states[id];

test("cards come from the applets, most urgent first", () => {
  withConfig();
  const rows = collectCards(
    [
      applet("calm", () => ({ priority: 5, text: "calm line" })),
      applet("loud", () => ({ priority: 80, text: "loud line" })),
      applet("quiet", () => null),
    ],
    peek,
  );
  expect(rows.map((r) => r.text)).toEqual(["loud line", "calm line"]);
  // `navigate` and the row's color default to the contributing applet.
  expect(rows.map((r) => r.navigate)).toEqual(["loud", "calm"]);
  expect(rows[0]!.color).toBe("#111111");
});

test("an applet with nothing live contributes nothing — no empty rows", () => {
  withConfig();
  const rows = collectCards(
    [
      applet("quiet", () => ({ show: false, text: "0 unread" })),
      applet("calm", () => []),
      applet("loud", () => undefined),
    ],
    peek,
  );
  expect(rows).toEqual([]);
});

test("several cards from one applet are keyed <applet>:<id>", () => {
  withConfig();
  const rows = collectCards(
    [
      applet("loud", () => [
        { id: "a", priority: 10, text: "a" },
        { id: "b", priority: 90, text: "b" },
      ]),
    ],
    peek,
  );
  expect(rows.map((r) => `${r.key} ${r.text}`)).toEqual(["loud:b b", "loud:a a"]);
});

test("a card that throws costs its applet a row, not the cockpit", () => {
  withConfig();
  const rows = collectCards(
    [
      applet("boom", () => {
        throw new Error("nope");
      }),
      applet("loud", () => ({ text: "still here" })),
    ],
    peek,
  );
  expect(rows.map((r) => r.applet)).toEqual(["loud"]);
});

test("an applet the daemon has no state for is skipped", () => {
  withConfig();
  const rows = collectCards([applet("ghost", () => ({ text: "boo" }))], peek);
  expect(rows).toEqual([]);
});

test("[applets.dash] hides and pins by applet or card key", () => {
  withConfig(`[applets.dash]\npin = ["calm"]\nhide = ["loud:b"]`);
  const rows = collectCards(
    [
      applet("calm", () => ({ priority: 5, text: "calm line" })),
      applet("loud", () => [
        { id: "a", priority: 80, text: "a" },
        { id: "b", priority: 90, text: "b" },
      ]),
    ],
    peek,
  );
  expect(rows.map((r) => r.key)).toEqual(["calm", "loud:a"]);
});

test("compact density keeps only the cards that want something from you", () => {
  withConfig(`[applets.dash]\ndensity = "compact"`);
  const rows = collectCards(
    [
      applet("calm", () => ({ priority: 5, text: "calm line" })),
      applet("loud", () => ({ priority: 80, text: "loud line" })),
    ],
    peek,
  );
  expect(rows.map((r) => r.text)).toEqual(["loud line"]);
});

test("the real applets are content-aware: idle says nothing, live says one line", () => {
  withConfig();
  const idle = { ...timer.initialState } as AppletState;
  expect(collectCards([timer as unknown as AnyApplet], () => idle)).toEqual([]);

  const running = {
    ...timer.initialState,
    timers: [{ id: "t1", label: "tea", remaining: 743, total: 900, running: true }],
  } as unknown as AppletState;
  const [card] = collectCards([timer as unknown as AnyApplet], () => running);
  expect(card?.text).toContain("12:23");
  expect(card?.navigate).toBe("timer");

  const silent = { ...spotify.initialState } as AppletState;
  expect(collectCards([spotify as unknown as AnyApplet], () => silent)).toEqual([]);
});

test("selecting a card navigates into the applet that contributed it", () => {
  withConfig();
  const state = {
    cards: [
      { applet: "timer", key: "timer", text: "⏲ 12:23", note: "", color: "#fff", priority: 65, navigate: "timer" },
      { applet: "spotify", key: "spotify", text: "♪ track", note: "", color: "#fff", priority: 45, navigate: "spotify" },
    ],
    gh: [],
    ghError: null,
    cursor: 0,
  };
  const ctx = { state, emit: () => {} } as never;
  // A click passes the row it hit; -> alone acts on the cursor.
  expect(dash.verbs.open!({ index: 1 }, ctx)).toEqual({ navigate: "spotify" });
  expect(dash.verbs.open!({}, ctx)).toEqual({ navigate: "spotify" });
  dash.verbs.up!({}, ctx);
  expect(dash.verbs.open!({}, ctx)).toEqual({ navigate: "timer" });
});
