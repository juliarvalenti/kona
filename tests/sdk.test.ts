import { test, expect } from "bun:test";
import { bindingFor, defineApplet, toolsForApplet } from "../sdk/index.ts";

test("toolsForApplet produces <id>.<verb> manifest entries", () => {
  const applet = defineApplet({
    id: "demo",
    title: "Demo",
    initialState: { n: 0 },
    verbs: {
      inc: (_a, { state, emit }) => {
        state.n++;
        emit();
      },
      reset: (_a, { state, emit }) => {
        state.n = 0;
        emit();
      },
    },
    view: (s) => `n=${s.n}`,
  });

  const tools = toolsForApplet(applet);
  expect(tools.map((t) => t.name).sort()).toEqual(["demo.inc", "demo.reset"]);
  expect(tools[0]).toMatchObject({ applet: "demo" });
});

test("defineApplet is an identity passthrough", () => {
  const def = defineApplet({
    id: "x",
    title: "X",
    initialState: {},
    verbs: {},
    view: () => "",
  });
  expect(def.id).toBe("x");
});

test("bindingFor resolves a key only when the applet claims it", () => {
  const applet = defineApplet({
    id: "player",
    title: "Player",
    initialState: { mode: "now" as "now" | "browse" },
    verbs: {},
    view: () => "",
    keymap: {
      space: "playPause",
      left: { verb: "seek", args: { deltaMs: -10_000 }, label: "seek", when: (s) => s.mode === "now" },
    },
  });

  // Unbound keys are never claimed, so navigation keeps them.
  expect(bindingFor(applet, "q", { mode: "now" })).toBeNull();
  // Every claimed key comes back in ONE shape, sugar expanded: the shorthand
  // gets empty args and labels itself with its verb name.
  expect(bindingFor(applet, "space", { mode: "browse" })).toEqual({
    verb: "playPause",
    args: {},
    label: "playPause",
  });
  // `when` decides per state: ← seeks on now-playing, navigates in a list.
  expect(bindingFor(applet, "left", { mode: "now" })).toEqual({
    verb: "seek",
    args: { deltaMs: -10_000 },
    label: "seek",
  });
  expect(bindingFor(applet, "left", { mode: "browse" })).toBeNull();
});
