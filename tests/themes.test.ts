import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import {
  DEFAULT_THEME,
  loadConfig,
  refreshConfig,
  resetConfig,
  setThemeOverride,
  theme,
  themeOverride,
  writeThemePreset,
  type Theme,
} from "../core/config.ts";
import { DEFAULT_PRESET, THEME_PRESETS, presetIds, resolvePreset, themePreset } from "../core/themes.ts";
import { defineApplet, text, type AppletDef, type AppletState } from "../sdk/index.ts";

/**
 * Named presets, and the live half that makes them switchable without a
 * restart: a palette resolved from the config, an override the picker previews
 * through, and a stage that repaints in whatever the theme says RIGHT NOW.
 */

const dirs: string[] = [];
const prevDir = process.env.KONA_CONFIG_DIR;

function withConfig(toml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kona-themes-"));
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

const ROLES = Object.keys(DEFAULT_THEME) as (keyof Theme)[];
const HEX = /^#[0-9a-f]{6}$/;

test("every preset fills every role with a real color", () => {
  expect(THEME_PRESETS.length).toBeGreaterThan(10);
  // Name the offenders rather than failing on the first one: a new preset with
  // three missing roles should say all three.
  const bad = THEME_PRESETS.flatMap((p) =>
    ROLES.filter((role) => !HEX.test(p.theme[role] ?? "")).map((role) => `${p.id}.${role}`),
  );
  expect(bad).toEqual([]);
  for (const p of THEME_PRESETS) {
    expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // The roles that must not collapse into their own background, or the thing
    // they name (a code block, a caret, a selected row) becomes unreadable.
    expect(p.theme.field).not.toBe(p.theme.fg);
    expect(p.theme.caretFg).not.toBe(p.theme.caret);
    expect(p.theme.bg).not.toBe(p.theme.accent);
  }
});

test("preset ids are unique, and the classics are all here", () => {
  const ids = presetIds();
  expect(new Set(ids).size).toBe(ids.length);
  for (const want of [
    "kona-aloha",
    "catppuccin-latte",
    "catppuccin-mocha",
    "nord",
    "dracula",
    "gruvbox-dark",
    "gruvbox-light",
    "tokyo-night",
    "rose-pine",
    "solarized-dark",
    "everforest",
    "kanagawa",
    "one-dark",
    "ayu-dark",
  ]) {
    expect(ids).toContain(want);
  }
});

test("kona's own palette IS a preset — no second list to drift", () => {
  expect(themePreset(DEFAULT_PRESET)!.theme).toEqual(DEFAULT_THEME);
  expect(THEME_PRESETS[0]!.id).toBe(DEFAULT_PRESET); // and it leads the list
});

test("a name resolves by id, by label, or by an unambiguous fragment", () => {
  expect(resolvePreset("nord")).toBe("nord");
  expect(resolvePreset("Catppuccin Mocha")).toBe("catppuccin-mocha");
  expect(resolvePreset("mocha")).toBe("catppuccin-mocha");
  expect(resolvePreset("tokyo night")).toBe("tokyo-night");
  expect(resolvePreset("nonesuch")).toBeNull();
  // Ambiguous is a miss, not a guess: three presets are "light".
  expect(resolvePreset("light")).toBeNull();
});

test("[theme] preset picks the base palette", () => {
  withConfig(`[theme]\npreset = "nord"\n`);
  const cfg = loadConfig();
  expect(cfg.errors).toEqual([]);
  expect(cfg.preset).toBe("nord");
  expect(cfg.theme).toEqual(themePreset("nord")!.theme);
  expect(cfg.themeOverrides).toEqual({});
});

test("an explicit role still wins over the preset", () => {
  withConfig(`[theme]\npreset = "dracula"\naccent = "#ff00ff"\n`);
  const cfg = loadConfig();
  expect(cfg.errors).toEqual([]);
  expect(cfg.theme.accent).toBe("#ff00ff");
  expect(cfg.theme.fg).toBe(themePreset("dracula")!.theme.fg); // the rest is Dracula
  expect(cfg.themeOverrides).toEqual({ accent: "#ff00ff" });
});

test("an unknown preset is a complaint, not a crash", () => {
  withConfig(`[theme]\npreset = "midnight-commander"\nok = "#00ff00"\n`);
  const cfg = loadConfig();
  expect(cfg.preset).toBe(DEFAULT_PRESET);
  expect(cfg.theme.ok).toBe("#00ff00"); // the roles it CAN read still apply
  expect(cfg.errors.join(" ")).toContain("midnight-commander");
  // `preset` is a key of its own, never reported as a bogus role.
  expect(cfg.errors.join(" ")).not.toContain("unknown role");
});

test("writing a preset leaves the rest of the file alone, twice over", () => {
  const dir = withConfig(`# mine\ndefault = "dash"\n\n[theme]\naccent = "#ff00ff"\n\n[applets.timer]\ndefault = "12m"\n`);
  const file = join(dir, "config.toml");
  writeThemePreset("nord");
  writeThemePreset("gruvbox-light"); // a second switch REPLACES, never appends
  const written = readFileSync(file, "utf8");
  expect(written.match(/preset =/g)).toHaveLength(1);
  expect(written).toContain(`preset = "gruvbox-light"`);
  expect(written).toContain("# mine");
  expect(written).toContain(`accent = "#ff00ff"`);
  expect(written).toContain(`default = "12m"`);
  expect(loadConfig().preset).toBe("gruvbox-light");
  expect(loadConfig().theme.accent).toBe("#ff00ff");
});

test("writing a preset with no config file writes one", () => {
  const dir = withConfig();
  expect(writeThemePreset("catppuccin-mocha")).toBe(join(dir, "config.toml"));
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(`[theme]\npreset = "catppuccin-mocha"\n`);
  expect(theme()).toEqual(themePreset("catppuccin-mocha")!.theme);
});

test("writeThemePreset refuses a preset that doesn't exist", () => {
  const dir = withConfig();
  expect(() => writeThemePreset("nonesuch")).toThrow("nonesuch");
  expect(() => readFileSync(join(dir, "config.toml"), "utf8")).toThrow();
});

test("refreshConfig notices a file that changed under a running process", () => {
  const dir = withConfig(`[theme]\npreset = "nord"\n`);
  const file = join(dir, "config.toml");
  expect(theme().accent).toBe(themePreset("nord")!.theme.accent);
  expect(refreshConfig()).toBe(false); // nothing moved

  // What the daemon does when a verb saves a theme, seen from the host.
  writeFileSync(file, `[theme]\npreset = "dracula"\n`);
  utimesSync(file, new Date(), new Date(Date.now() + 1000));
  expect(refreshConfig()).toBe(true);
  expect(theme().accent).toBe(themePreset("dracula")!.theme.accent);
  expect(refreshConfig()).toBe(false); // and it settles
});

test("an override stands in for the configured palette until it is dropped", () => {
  withConfig(`[theme]\npreset = "nord"\n`);
  expect(themeOverride()).toBeNull();
  setThemeOverride({ accent: "#123456" });
  expect(theme().accent).toBe("#123456");
  expect(theme().fg).toBe(themePreset("nord")!.theme.fg); // a partial is a merge
  setThemeOverride(null);
  expect(theme()).toEqual(themePreset("nord")!.theme);
});

// --- the live half: one stage, two palettes, no restart -------------------

const demo = defineApplet<{ n: number }>({
  id: "demo",
  title: "Demo",
  initialState: { n: 0 },
  verbs: {},
  view: () => [text("body")],
});

/** The color the stage painted the frame's top-left corner in. */
async function borderColorOf(draw: (stage: ReturnType<typeof createStage>) => void, twice = false) {
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 40, height: 10 });
  const stage = createStage(renderer);
  const shot = async () => {
    draw(stage);
    await renderOnce();
    for (const line of captureSpans().lines) {
      for (const span of line.spans) {
        if (span.text.includes("╭")) {
          const [r, g, b] = span.fg.toInts();
          return `#${[r, g, b].map((n: number) => n.toString(16).padStart(2, "0")).join("")}`;
        }
      }
    }
    return null;
  };
  const first = await shot();
  const second = twice ? await shot() : first;
  renderer.destroy();
  return { first, second };
}

test("the stage repaints in the new palette without being rebuilt", async () => {
  withConfig();
  const def = demo as unknown as AppletDef;
  const { first, second } = await borderColorOf((stage) => {
    // Between the two frames the theme moves — exactly what the picker does
    // while you hold ↓. A stage that captured its colors once would draw the
    // first palette forever.
    if (themeOverride()) return stage.renderApplet(def, { n: 1 } as AppletState);
    stage.renderApplet(def, { n: 0 } as AppletState);
    setThemeOverride(themePreset("dracula")!.theme);
  }, true);
  expect(first).toBe(DEFAULT_THEME.accent);
  expect(second).toBe(themePreset("dracula")!.theme.accent);
  setThemeOverride(null);
});
