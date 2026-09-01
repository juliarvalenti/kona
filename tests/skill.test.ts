import { test, expect } from "bun:test";
import { join } from "node:path";
import { defineApplet, toolsForApplet, type AnyApplet } from "../sdk/index.ts";
import { skillMarkdown, exampleCall } from "../core/skill.ts";
import { loadApplets, REPO_ROOT } from "../core/load.ts";

/**
 * The agent seam's documentation half: a manifest rich enough to drive kona
 * without hardcoding anything, and a skill file generated from it.
 */

const demo = defineApplet({
  id: "demo",
  title: "Demo",
  summary: "A demo applet.",
  initialState: { n: 0, cursor: 0 },
  docs: {
    inc: { doc: "Bump the counter.", args: { by: 2 } },
    reset: "Back to zero.",
  },
  recipes: [{ title: "Count to two", steps: [`kona call demo inc '{"by":2}'`], note: "twice as fast" }],
  verbs: {
    inc: () => {},
    reset: () => {},
    up: () => {},
    down: () => {},
  },
  view: () => "",
  keymap: { i: "inc", r: { verb: "reset", label: "reset" } },
  nav: { up: "up", down: "down", select: "inc" },
  search: { verb: "reset" },
}) as unknown as AnyApplet;

test("the manifest carries docs, example args, and the key that fires the verb", () => {
  const byName = Object.fromEntries(toolsForApplet(demo).map((t) => [t.name, t]));

  expect(byName["demo.inc"]).toMatchObject({
    applet: "demo",
    verb: "inc",
    title: "Demo",
    summary: "A demo applet.",
    doc: "Bump the counter.",
    args: { by: 2 },
    key: "i",
  });
  // A string doc is the one-liner, with no example args.
  expect(byName["demo.reset"]!.doc).toBe("Back to zero.");
  expect(byName["demo.reset"]!.args).toBeUndefined();
  // Cursor verbs are flagged so an agent can skip them; acting verbs are not.
  expect(byName["demo.up"]!.nav).toBe(true);
  expect(byName["demo.inc"]!.nav).toBeUndefined();
});

test("an example call is pasteable, with and without args", () => {
  const [inc, reset] = ["inc", "reset"].map(
    (v) => toolsForApplet(demo).find((t) => t.verb === v)!,
  );
  expect(exampleCall(inc)).toBe(`kona call demo inc '{"by":2}'`);
  expect(exampleCall(reset)).toBe("kona call demo reset");
});

test("the skill is generated from the applets that are actually loaded", () => {
  const md = skillMarkdown([demo], { base: "http://localhost:9999" });

  expect(md.startsWith("---\nname: kona\n")).toBe(true);
  expect(md).toContain("description: Drive kona applets");
  expect(md).toContain("### demo — Demo");
  expect(md).toContain(`kona call demo inc '{"by":2}'`);
  expect(md).toContain("http://localhost:9999/applets/<id>/state"); // the HTTP seam
  expect(md).toContain("Count to two"); // the applet's own worked example
  expect(md).toContain("Installed: `demo`.");
  // Cursor verbs are named but not given an agent-facing entry of their own.
  expect(md).toContain("Cursor verbs");
  expect(md).not.toContain("- `demo.up`");
});

test("the checked-in skill matches the generator — it can't rot in place", async () => {
  const applets = await loadApplets();
  const onDisk = await Bun.file(join(REPO_ROOT, ".claude", "skills", "kona", "SKILL.md")).text();
  expect(onDisk).toBe(skillMarkdown(applets));
});
