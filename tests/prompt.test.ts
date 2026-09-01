import { test, expect } from "bun:test";
import { defineApplet, type AnyApplet } from "../sdk/index.ts";
import { appletPrompt, surfacePrompt } from "../core/prompt.ts";
import { clipboardCommand } from "../core/clipboard.ts";
import { renderApplet, renderLauncher } from "../sdk/testing.ts";

/**
 * "Copy prompt": the blurb a human copies out of the TUI to teach the agent in
 * the next window how to drive the surface they are staring at. It is rendered
 * from the live manifest, so these tests pin that it says what the applet
 * actually declares — verbs, example args, keys — and nothing hardcoded.
 */

const demo = defineApplet({
  id: "demo",
  title: "Demo",
  summary: "A demo applet.",
  initialState: { n: 0 },
  docs: {
    inc: { doc: "Bump the counter.", args: { by: 2 } },
    reset: "Back to zero.",
  },
  recipes: [{ title: "Count to two", steps: [`kona call demo inc '{"by":2}'`] }],
  verbs: { inc: () => {}, reset: () => {}, up: () => {}, down: () => {}, find: () => {} },
  view: () => "",
  keymap: { i: "inc" },
  nav: { up: "up", down: "down" },
  search: { verb: "find" },
}) as unknown as AnyApplet;

const other = defineApplet({
  id: "other",
  title: "Other",
  initialState: {},
  verbs: { go: () => {} },
  view: () => "",
}) as unknown as AnyApplet;

test("an applet's prompt carries its verbs, example args and keys", () => {
  const p = appletPrompt(demo);

  expect(p).toContain("Drive the kona applet `demo` (Demo)");
  expect(p).toContain("A demo applet.");
  // The verb, its doc, the pasteable call, and the key a human presses.
  expect(p).toContain("- `demo.inc` — Bump the counter.");
  expect(p).toContain(`kona call demo inc '{"by":2}'`);
  expect(p).toContain("key `i`");
  // Cursor verbs are named as the keyboard's business, not listed as tools.
  expect(p).toContain("Cursor verbs");
  expect(p).not.toContain("- `demo.up`");
  // The search seam and the applet's own worked examples come along.
  expect(p).toContain(`\`demo.find\` takes \`{"q": "..."}\``);
  expect(p).toContain("Count to two");
  // Acting verbs only: inc, reset, find.
  expect(p).toContain("3 verbs on `demo`");
});

test("the prompt documents both seams, at the port the host is on", () => {
  const p = appletPrompt(demo, { base: "http://localhost:9999" });

  expect(p).toContain("kona call demo <verb> '<json>'");
  expect(p).toContain("kona state demo");
  expect(p).toContain("POST http://localhost:9999/applets/demo/verbs/<verb>");
  expect(p).toContain("GET  http://localhost:9999/applets/demo/state");
  expect(p).toContain("GET  http://localhost:9999/events");
  // No other applet's port, and no applet-specific hardcoding of the default.
  expect(p).not.toContain("4177");
});

test("the launcher's prompt is the whole surface set", () => {
  const p = surfacePrompt([demo, other]);

  expect(p).toContain("Drive kona (2 applets on this machine)");
  expect(p).toContain("Installed: `demo`, `other`.");
  expect(p).toContain("## demo — Demo");
  expect(p).toContain("## other — Other");
  expect(p).toContain("kona call <applet> <verb> '<json>'");
});

test("one applet still reads as one applet", () => {
  expect(surfacePrompt([other])).toContain("Drive kona (1 applet on this machine)");
  expect(appletPrompt(other)).toContain("1 verb on `other`");
});

test("the clipboard helper is chosen per platform, and overridable", () => {
  expect(clipboardCommand("darwin")).toEqual(["pbcopy"]);
  expect(clipboardCommand("win32")).toEqual(["clip"]);
  // Linux takes whichever helper the session actually has...
  expect(clipboardCommand("linux", (bin) => bin === "xclip")).toEqual([
    "xclip",
    "-selection",
    "clipboard",
  ]);
  // ...and says so rather than pretending, when it has none.
  expect(clipboardCommand("linux", () => false)).toBeNull();

  // KONA_CLIPBOARD wins everywhere — an ssh session's clipboard is a pipe.
  process.env.KONA_CLIPBOARD = "ssh mac pbcopy";
  try {
    expect(clipboardCommand("linux", () => false)).toEqual(["ssh", "mac", "pbcopy"]);
  } finally {
    delete process.env.KONA_CLIPBOARD;
  }
});

test("the copy-prompt key is advertised on an applet", async () => {
  expect(await renderApplet(demo, {}, 80, 12)).toContain("y prompt");
});

test("the launcher advertises filter, not copy-prompt (type-to-filter owns bare keys)", async () => {
  // The launcher starts a filter on any printable key (#40), so it can't also
  // bind a bare letter to copy-prompt. Copy-prompt lives on applets; the whole
  // launcher set is not copyable from a keystroke (see follow-up).
  const frame = await renderLauncher([demo, other], 0, 80, 12);
  expect(frame).toContain("filter");
  expect(frame).not.toContain("y prompt");
});

test("an applet that binds the key keeps it — the platform hint is a default", async () => {
  const mine = defineApplet({
    id: "mine",
    title: "Mine",
    initialState: {},
    verbs: { yank: () => {} },
    view: () => "",
    keymap: { y: { verb: "yank", label: "yank" } },
  }) as unknown as AnyApplet;

  const frame = await renderApplet(mine, {}, 80, 12);
  expect(frame).toContain("y yank");
  expect(frame).not.toContain("y prompt");
});
