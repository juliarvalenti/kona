import { test, expect } from "bun:test";
import { defineApplet, toolsForApplet, type AnyApplet } from "../sdk/index.ts";
import { skillMarkdown, exampleCall } from "../core/skill.ts";
import { loadApplets } from "../core/load.ts";

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

test("the skill describes every applet the loader found, and nothing else", async () => {
  // The skill is generated, never committed: `bun run skill` (and a
  // SessionStart hook) renders it from the applets this machine has, so it
  // cannot describe a verb that isn't installed — and adding an applet doesn't
  // mean committing a regenerated file that collides with somebody else's.
  const applets = await loadApplets();
  const md = skillMarkdown(applets);
  for (const a of applets) {
    expect(md).toContain(`### ${a.id} — ${a.title}`);
    for (const verb of Object.keys(a.verbs)) {
      if (a.docs?.[verb]) expect(md).toContain(`\`${a.id}.${verb}\``);
    }
  }
  expect(md).toContain(`Installed: ${applets.map((a) => `\`${a.id}\``).join(", ")}.`);
  expect(md).not.toContain("### nonexistent");
});
