import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import theme from "./index.ts";
import { loadConfig, resetConfig, theme as palette } from "../../core/config.ts";
import { THEME_PRESETS, themePreset } from "../../core/themes.ts";
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
  const h = harness({ applied: "nord", cursor: index("nord") });
  expect(theme.nav!.canBack!(h.state)).toBe(false);
  h.call("down");
  expect(theme.nav!.canBack!(h.state)).toBe(true);
  h.call("reset");
  expect(h.state.cursor).toBe(index("nord"));
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
