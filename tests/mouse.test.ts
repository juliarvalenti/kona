import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { loadApplets } from "../core/load.ts";
import { createStage, type StageMouse } from "../host/stage.ts";
import type { AppletState } from "../sdk/index.ts";

/**
 * Mouse tests. They drive the real stage through OpenTUI's headless renderer:
 * the mock mouse writes actual SGR escape sequences into stdin, so hit-testing,
 * bubbling and the wheel all run for real — only the terminal is fake.
 */

const THREADS = Array.from({ length: 40 }, (_, i) => ({
  id: `${i}`,
  from: `sender ${i}`,
  subject: `subject ${i}`,
  snippet: "",
  date: "",
  unread: false,
}));

async function mount(width = 60, height = 16) {
  const applets = await loadApplets();
  const { renderer, renderOnce, captureCharFrame, mockMouse } = await createTestRenderer({ width, height });
  const stage = createStage(renderer);
  const seen: StageMouse[] = [];
  stage.onMouse((e) => seen.push(e));

  /** Screen row of the first line containing `needle`. */
  const lineOf = (needle: string) => captureCharFrame().split("\n").findIndex((l) => l.includes(needle));

  // Hand back a teardown: renderers register process-wide listeners, and a
  // suite full of leaked ones trips node's max-listeners warning.
  const done = () => renderer.destroy();

  return { applets, stage, renderOnce, captureCharFrame, mockMouse, seen, lineOf, done };
}

async function mountEmail(state: Record<string, unknown> = {}) {
  const m = await mount();
  const def = m.applets.find((a) => a.id === "email")!;
  m.stage.renderApplet(def, { ...def.initialState, authed: true, cursor: 0, threads: THREADS, ...state } as AppletState);
  await m.renderOnce();
  return m;
}

test("clicking a row reports that row's select index", async () => {
  const { mockMouse, seen, lineOf, renderOnce, done } = await mountEmail();
  const y = lineOf("subject 3");
  expect(y).toBeGreaterThan(0);

  await mockMouse.click(10, y);
  await renderOnce();

  const clicks = seen.filter((e) => e.kind === "click");
  expect(clicks.length).toBe(1);
  expect(clicks[0]!.index).toBe(3);
  done();
});

test("clicking chrome or a non-selectable line selects nothing", async () => {
  const { mockMouse, seen, lineOf, renderOnce, done } = await mountEmail();
  const header = lineOf("loaded"); // the dim status line above the list
  expect(header).toBeGreaterThan(0);

  await mockMouse.click(10, header); // a plain text line
  await mockMouse.click(10, 0); // the frame border
  await renderOnce();

  const clicks = seen.filter((e) => e.kind === "click");
  expect(clicks.length).toBe(2);
  expect(clicks.every((c) => c.index === null)).toBe(true);
  done();
});

test("the wheel scrolls the stage — and only the stage", async () => {
  const { stage, mockMouse, seen, renderOnce, done } = await mountEmail();
  expect(stage.scrollTop()).toBe(0);

  await mockMouse.scroll(10, 6, "down");
  await renderOnce();

  const wheels = seen.filter((e) => e.kind === "wheel");
  expect(wheels.length).toBe(1);
  expect(wheels[0]!.lines).toBeGreaterThan(0);
  // The stage owns scrolling: the gesture is reported, never applied behind the
  // host's back (no double-scroll from the ScrollBox's own wheel handling).
  expect(stage.scrollTop()).toBe(0);

  stage.scrollBy(wheels[0]!.lines);
  expect(stage.scrollTop()).toBe(wheels[0]!.lines);

  await mockMouse.scroll(10, 6, "up");
  await renderOnce();
  const up = seen.filter((e) => e.kind === "wheel").at(-1)!;
  expect(up.lines).toBeLessThan(0);
  stage.scrollBy(up.lines);
  expect(stage.scrollTop()).toBe(0);
  done();
});

test("a click resolves against the scrolled position, not the original one", async () => {
  const { stage, mockMouse, seen, lineOf, renderOnce, done } = await mountEmail();
  stage.scrollBy(5);
  await renderOnce();
  expect(stage.scrollTop()).toBe(5); // row 9 is only on screen once scrolled

  const y = lineOf("subject 9");
  expect(y).toBeGreaterThan(0);
  await mockMouse.click(10, y);
  await renderOnce();

  expect(seen.filter((e) => e.kind === "click").at(-1)!.index).toBe(9);
  done();
});

test("a select verb given an index selects that row before acting", async () => {
  // The applet half of the contract: the click carries `{ index }`, the verb
  // moves its cursor there and then acts on it (here: hyperlink into spotify).
  const applets = await loadApplets();
  const dash = applets.find((a) => a.id === "dash")!;
  const state = {
    ...dash.initialState,
    cards: [
      {
        applet: "spotify",
        key: "spotify",
        text: "♪ Rave Green — Sounders FC",
        note: "▶",
        color: "#1db954",
        priority: 45,
        navigate: "spotify",
      },
    ],
    gh: [{ type: "Issue", title: "mouse support", repo: "kona", url: "http://example.test/9", age: "1d" }],
    cursor: 1, // cursor is on the GitHub row; the click lands on the spotify card
  } as AppletState;

  const result = await dash.verbs.open!({ index: 0 }, { state, emit: () => {} });

  expect(state.cursor).toBe(0);
  expect(result).toEqual({ navigate: "spotify" });
});

test("launcher rows are clickable — at the cursor's scrolled position", async () => {
  // Deliberately SHORTER than the launcher needs: with the cursor on the last
  // applet the list has scrolled to it, and the click still has to resolve to
  // that row rather than to whatever used to occupy the line.
  const { applets, stage, mockMouse, seen, lineOf, renderOnce, done } = await mount(60, 20);
  const last = applets.length - 1;
  stage.renderLauncher(applets, last);
  await renderOnce();

  const y = lineOf(applets[last]!.title);
  expect(y).toBeGreaterThan(0);
  expect(stage.scrollTop()).toBeGreaterThan(0); // it really did scroll

  await mockMouse.click(6, y);
  await renderOnce();

  expect(seen.filter((e) => e.kind === "click").at(-1)!.index).toBe(last);
  done();
});
