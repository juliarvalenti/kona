import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import theme from "./index.ts";
import { loadConfig, resetConfig, theme as palette } from "../../core/config.ts";
import { THEME_PRESETS, themePreset } from "../../core/themes.ts";
import { BIG_FONTS } from "../../core/fonts.ts";
import { renderApplet } from "../../sdk/testing.ts";
import type { AnyApplet, AppletCtx } from "../../sdk/index.ts";

/**
 * The picker writes the human's config file, so every test points
 * KONA_CONFIG_DIR at a throwaway dir first — a suite that retinted the machine
 * it ran on would be a rude test.
 */

const dirs: string[] = [];
const prevDir = process.env.KONA_CONFIG_DIR;

function withConfig(toml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kona-theme-"));
  dirs.push(dir);
  if (toml !== undefined) writeFileSync(join(dir, "config.toml"), toml);
  process.env.KONA_CONFIG_DIR = dir;
  resetConfig();
  return dir;
}

afterEach(() => {
  if (prevDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevDir;
  resetConfig();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type ThemeState = typeof theme.initialState;

/** Drive the applet exactly as the daemon does: one state, verbs, emits. */
function harness(over: Partial<ThemeState> = {}) {
  const state: ThemeState = { ...structuredClone(theme.initialState), ...over };
  let emits = 0;
  const ctx: AppletCtx<ThemeState> = { state, emit: () => void emits++ };
  return {
    state,
    ctx,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => theme.verbs[verb]!(args, ctx),
  };
}

const index = (id: string) => THEME_PRESETS.findIndex((p) => p.id === id);

test("list reads the catalog and what is applied, and changes nothing", () => {
  withConfig(`[theme]\npreset = "nord"\n`);
  const h = harness();
  const out = h.call("list") as { applied: string; presets: { id: string }[] };
  expect(out.applied).toBe("nord");
  expect(out.presets.map((p) => p.id)).toContain("catppuccin-mocha");
  expect(h.state.applied).toBe("nord");
  expect(h.emits()).toBe(0);
});

test("preview moves the cursor and writes nothing to disk", () => {
  const dir = withConfig();
  const h = harness();
  expect(h.call("preview", { preset: "tokyo-night" })).toMatchObject({
    previewing: "tokyo-night",
    saved: false,
  });
  expect(h.state.cursor).toBe(index("tokyo-night"));
  // The preview lives in state; the file is untouched.
  expect(() => readFileSync(join(dir, "config.toml"), "utf8")).toThrow();
  expect(loadConfig().preset).toBe("kona-aloha");
});

test("the previewed palette is what the host paints with", () => {
  withConfig();
  const h = harness({ cursor: index("dracula") });
  expect(theme.theme!(h.state)).toMatchObject(themePreset("dracula")!.theme);
  expect(theme.accent!(h.state)).toBe(themePreset("dracula")!.theme.accent);
});

test("a role pinned in [theme] survives the preview and the save", () => {
  withConfig(`[theme]\nok = "#abcdef"\n`);
  const h = harness({ cursor: index("nord") });
  // Preview: Nord everywhere, except the role the config pinned.
  expect(theme.theme!(h.state)).toMatchObject({ accent: themePreset("nord")!.theme.accent, ok: "#abcdef" });
  h.call("set");
  expect(loadConfig().preset).toBe("nord");
  expect(palette().ok).toBe("#abcdef");
  expect(h.state.note).toContain("ok");
});

test("set writes the preset into the config and keeps the rest of the file", () => {
  const dir = withConfig(`default = "dash"\n\n# hand-written\n[applets.timer]\ndefault = "12m"\n`);
  const h = harness();
  const out = h.call("set", { preset: "catppuccin-mocha" }) as { applied: string; saved: boolean };
  expect(out).toMatchObject({ applied: "catppuccin-mocha", saved: true });
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  expect(written).toContain(`preset = "catppuccin-mocha"`);
  expect(written).toContain("# hand-written");
  expect(written).toContain(`default = "12m"`);
  const cfg = loadConfig();
  expect(cfg.preset).toBe("catppuccin-mocha");
  expect(cfg.defaultApplet).toBe("dash");
  expect(cfg.applets.timer?.default).toBe("12m");
  expect(h.state.applied).toBe("catppuccin-mocha");
});

test("set takes a fuzzy name, and says so when nothing matches", () => {
  withConfig();
  const h = harness();
  expect(h.call("set", { preset: "mocha" })).toMatchObject({ applied: "catppuccin-mocha" });
  const bad = h.call("set", { preset: "nonesuch" }) as { error: string };
  expect(bad.error).toContain("nonesuch");
  // A miss leaves the applied preset alone.
  expect(loadConfig().preset).toBe("catppuccin-mocha");
  expect(h.state.applied).toBe("catppuccin-mocha");
});

test("esc reverts: back is only offered while the preview differs", () => {
  withConfig(`[theme]\npreset = "nord"\n`);
  const h = harness();
  theme.init!(h.ctx); // opened on what the config holds — nothing to revert to
  expect(theme.nav!.canBack!(h.state)).toBe(false);
  h.call("down");
  expect(theme.nav!.canBack!(h.state)).toBe(true);
  h.call("reset");
  expect(h.state.cursor).toBe(index("nord"));
  expect(theme.nav!.canBack!(h.state)).toBe(false);

  // ...and the figlet axis reverts the same way, on its own.
  h.call("focus");
  h.call("down");
  expect(theme.nav!.canBack!(h.state)).toBe(true);
  h.call("reset");
  expect(h.state.fontCursor).toBe(0);
  expect(theme.nav!.canBack!(h.state)).toBe(false);
});

test("the cursor stops at both ends of the list", () => {
  withConfig();
  const h = harness();
  h.call("up");
  expect(h.state.cursor).toBe(0);
  for (let i = 0; i < THEME_PRESETS.length + 3; i++) h.call("down");
  expect(h.state.cursor).toBe(THEME_PRESETS.length - 1);
});

test("init opens on the preset the config holds, whatever state was saved", () => {
  withConfig(`[theme]\npreset = "gruvbox-dark"\n`);
  const h = harness({ cursor: index("dracula"), applied: "dracula" });
  theme.init!(h.ctx);
  expect(h.state.applied).toBe("gruvbox-dark");
  expect(h.state.cursor).toBe(index("gruvbox-dark"));
});

test("`kona theme nord` applies before the TUI opens", () => {
  expect(theme.cli!.open!(["nord"], harness().state)).toEqual({ verb: "set", args: { preset: "nord" } });
  expect(theme.cli!.open!([], harness().state)).toBeNull();
});

test("the list renders every preset, ticked and previewed", async () => {
  withConfig();
  const frame = await renderApplet(
    theme as unknown as AnyApplet,
    { cursor: index("nord"), applied: "kona-aloha" },
    80,
    40,
  );
  expect(frame).toContain("▸ Nord");
  expect(frame).toContain("✓ kona aloha");
  expect(frame).toContain("previewing Nord");
  for (const p of THEME_PRESETS) expect(frame).toContain(p.label);
});

/**
 * The second axis. A palette suggests a figlet; it doesn't own one — so these
 * pin what `tab` moves, what the two cursors compose into, and what ends up in
 * the file when a face is (and isn't) the preset's own.
 */

const fontRow = (font: string) => THEME_PRESETS.length + 1 + BIG_FONTS.indexOf(font as never);

test("tab hands the arrows to the figlet list, and back", () => {
  withConfig();
  const h = harness();
  expect(h.state.axis).toBe("palette");
  h.call("down");
  expect(h.state.cursor).toBe(1);
  expect(h.state.fontCursor).toBe(0);

  expect(h.call("focus")).toEqual({ axis: "font" });
  h.call("down");
  expect(h.state.fontCursor).toBe(1); // the arrows moved the OTHER list
  expect(h.state.cursor).toBe(1); // ...and left this one where it was
  expect(h.call("focus")).toEqual({ axis: "palette" });
  expect(h.call("focus", { axis: "figlet" })).toEqual({ axis: "font" });
  expect(h.call("focus", { axis: "sideways" })).toMatchObject({ error: expect.stringContaining("sideways") });
});

test("the two axes compose: Nord's colors, a figlet Nord never shipped", () => {
  withConfig();
  const h = harness();
  h.call("preview", { preset: "nord", font: "huge" });
  const shown = theme.theme!(h.state)!;
  expect(shown.accent).toBe(themePreset("nord")!.theme.accent);
  expect(shown.font).toBe("huge"); // Nord's own is `grid`
  // Still a preview: nothing on disk, and the cursor sits on the face it drew.
  expect(loadConfig().theme.font).toBe("block");
  expect(h.state.fontCursor).toBe(fontRow("huge") - THEME_PRESETS.length);
});

test("`auto` is the row that lets the palette bring its own face", () => {
  withConfig();
  const h = harness();
  // The figlet cursor opens on `auto`, so arrowing palettes still re-letters.
  h.call("preview", { preset: "dracula" });
  expect(theme.theme!(h.state)!.font).toBe("huge");
  h.call("preview", { preset: "nord" });
  expect(theme.theme!(h.state)!.font).toBe("grid");
});

test("a face that isn't the preset's own is pinned; auto takes the pin out", () => {
  const dir = withConfig(`# mine\n[theme]\npreset = "kona-aloha"\n`);
  const file = join(dir, "config.toml");
  const h = harness();

  expect(h.call("set", { preset: "nord", font: "huge" })).toMatchObject({
    applied: "nord",
    font: "huge",
    saved: true,
  });
  expect(readFileSync(file, "utf8")).toContain(`font = "huge"`);
  expect(loadConfig().theme.font).toBe("huge");
  expect(loadConfig().theme.accent).toBe(themePreset("nord")!.theme.accent);
  expect(readFileSync(file, "utf8")).toContain("# mine");

  // `auto` writes no font line at all — the palette gets its face back.
  expect(h.call("font", { font: "auto" })).toMatchObject({ applied: "nord", font: "grid" });
  expect(readFileSync(file, "utf8")).not.toContain("font =");
  expect(loadConfig().theme.font).toBe("grid");
  expect(h.state.fontCursor).toBe(0);
});

test("theme.font re-letters without touching the palette", () => {
  withConfig(`[theme]\npreset = "nord"\n`);
  const h = harness();
  expect(h.call("font", { font: "hug" })).toMatchObject({ applied: "nord", font: "huge" });
  expect(loadConfig().preset).toBe("nord");
  expect(palette().font).toBe("huge");
  expect(palette().accent).toBe(themePreset("nord")!.theme.accent);
  expect(h.state.note).toContain("huge");
});

test("a figlet that doesn't match one face is refused, never guessed", () => {
  withConfig();
  const h = harness();
  expect(h.call("font", { font: "nonesuch" })).toMatchObject({ error: expect.stringContaining("nonesuch") });
  // `s` is both slick and shade — ambiguous is a miss, like an ambiguous preset.
  expect(h.call("font", { font: "s" })).toMatchObject({ error: expect.stringContaining("“s”") });
  expect(h.call("set", { preset: "nord", font: "nope" })).toMatchObject({ error: expect.any(String) });
  expect(loadConfig().exists).toBe(false); // and none of it wrote anything
});

test("init opens on the pinned face, and reset comes back to it", () => {
  withConfig(`[theme]\npreset = "nord"\nfont = "tiny"\n`);
  const h = harness();
  theme.init!(h.ctx);
  expect(h.state.appliedFont).toBe("tiny");
  expect(h.state.pinnedFont).toBe("tiny");
  expect(h.state.fontCursor).toBe(fontRow("tiny") - THEME_PRESETS.length);
  h.call("focus");
  h.call("up");
  expect(theme.theme!(h.state)!.font).not.toBe("tiny");
  h.call("reset");
  expect(theme.theme!(h.state)!.font).toBe("tiny");
});

test("a click lands on the row it hit, in whichever column it hit", () => {
  withConfig();
  const h = harness();
  // nav.select is fired with the clicked row's index — the figlet rows are
  // numbered after the palette's.
  h.call("set", { index: fontRow("shade") });
  expect(h.state.axis).toBe("font");
  expect(palette().font).toBe("shade");
  h.call("set", { index: index("dracula") });
  expect(h.state.axis).toBe("palette");
  expect(loadConfig().preset).toBe("dracula");
  expect(palette().font).toBe("shade"); // the face the other column still holds
});

test("`kona theme nord huge` sets both axes; `kona theme tiny` sets the face", () => {
  const s = harness().state;
  expect(theme.cli!.open!(["nord", "huge"], s)).toEqual({
    verb: "set",
    args: { preset: "nord", font: "huge" },
  });
  expect(theme.cli!.open!(["tiny"], s)).toEqual({ verb: "font", args: { font: "tiny" } });
  expect(theme.cli!.open!(["auto"], s)).toEqual({ verb: "font", args: { font: "auto" } });
  // A two-word preset is still one name: only an EXACT figlet is the last word.
  expect(theme.cli!.open!(["Tokyo", "Night"], s)).toEqual({
    verb: "set",
    args: { preset: "Tokyo Night" },
  });
});

test("the figlet column is on screen beside the palettes", async () => {
  withConfig();
  const frame = await renderApplet(
    theme as unknown as AnyApplet,
    { cursor: index("nord"), fontCursor: fontRow("huge") - THEME_PRESETS.length, axis: "font" },
    80,
    40,
  );
  expect(frame).toContain("figlet");
  expect(frame).toContain("auto");
  for (const f of BIG_FONTS) expect(frame).toContain(f);
  expect(frame).toContain("previewing Nord · huge");
});
