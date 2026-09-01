import { test, expect } from "bun:test";
import { defineApplet, toolsForApplet } from "../sdk/index.ts";

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
