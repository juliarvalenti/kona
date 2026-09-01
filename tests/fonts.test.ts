import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fonts, measureText } from "@opentui/core";
import { BIG_FONTS, bigFits, bigSize, fitBigFont, fontLines, isBigFont, type BigFont } from "../core/fonts.ts";
import { loadConfig, resetConfig, theme } from "../core/config.ts";
import { THEME_PRESETS } from "../core/themes.ts";
import { renderApplet } from "../sdk/testing.ts";
import { big, defineApplet, text, type AnyApplet } from "../sdk/index.ts";

/**
 * The figlets: kona's display typefaces as a theme role.
 *
 * Two things have to hold. The metrics in core/fonts.ts are a COPY of
 * OpenTUI's — kept local so the CLI doesn't import a renderer to size a
 * hero — so the first test measures every character against the real thing and
 * fails the moment upstream redraws a glyph. And a hero must fit the pane it is
 * drawn in, so the rest render one at a fixed width in every font and pin what
 * comes out: the size, and the narrower face the host falls back to when the
 * asked-for one would run off the side.
 */

const dirs: string[] = [];
const prevDir = process.env.KONA_CONFIG_DIR;

function withConfig(toml?: string): void {
  const dir = mkdtempSync(join(tmpdir(), "kona-fonts-"));
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

/** A frame's worth of hero: `big` with whatever the theme says, then a marker. */
const demo = defineApplet<{ text: string; font?: BigFont }>({
  id: "fonts-demo",
  title: "Fonts",
  initialState: { text: "00:00" },
  verbs: {},
  view: (s) => [big(s.text, undefined, s.font), text("|end")],
});

/** Render the demo and report the hero's real size on screen, in cells. */
async function heroSize(state: { text: string; font?: BigFont }, width = 62, height = 30) {
  const frame = await renderApplet(demo as unknown as AnyApplet, state, width, height);
  // Everything the stage drew above the marker row is the hero. The frame's
  // own chrome is fixed-width (` │ ` on the left, a scrollbar column and the
  // right border), so the pane's content is the same slice of every row.
  const lines = frame
    .split("\n")
    .filter((l) => /^\s*│/.test(l))
    .map((l) => l.slice(3, 3 + width - 7));
  const end = lines.findIndex((l) => l.includes("|end"));
  expect(end).toBeGreaterThan(0);
  const hero = lines.slice(0, end).filter((l) => l.trim() !== "");
  return { height: hero.length, width: Math.max(0, ...hero.map((l) => l.trimEnd().length)) };
}

test("kona's font metrics are the renderer's, character for character", () => {
  for (const font of BIG_FONTS) {
    const chars = Object.keys((fonts as Record<string, { chars: Record<string, string[]> }>)[font]!.chars);
    expect(chars.length).toBeGreaterThan(50);
    const wrong = chars.filter((c) => bigSize(c, font).width !== measureText({ text: c, font }).width);
    expect({ font, wrong }).toEqual({ font, wrong: [] });
    // Letterspacing and height too, on the strings kona actually draws big.
    for (const sample of ["kona", "00:00", "72", "1:23:45", "-9"]) {
      expect({ font, sample, ...bigSize(sample, font) }).toEqual({
        font,
        sample,
        ...measureText({ text: sample, font }),
      });
    }
    expect(fontLines(font)).toBe(measureText({ text: "kona", font }).height);
  }
});

test("a hero is drawn in the theme's figlet, at that figlet's size", async () => {
  // One snapshot per font at a FIXED width: the sizes below are what each
  // figlet costs for a countdown, and a change to any of them shows up here.
  const at62: Record<BigFont, { width: number; height: number }> = {
    tiny: { width: 17, height: 2 },
    grid: { width: 26, height: 6 },
    slick: { width: 26, height: 6 },
    pallet: { width: 26, height: 6 },
    shade: { width: 24, height: 8 },
    block: { width: 43, height: 6 },
    huge: { width: 24, height: 8 }, // 60 cells wide — too wide for a 62-col pane
  };
  for (const font of BIG_FONTS) {
    withConfig(`[theme]\nfont = "${font}"\n`);
    expect(theme().font).toBe(font);
    expect(await heroSize({ text: "00:00" })).toEqual(at62[font]);
  }
});

test("a pane too narrow for the theme's figlet gets a narrower one, never a wider", async () => {
  withConfig(`[theme]\nfont = "huge"\n`);
  // Wide enough for `huge` (60 cells) and it is drawn in `huge`...
  expect(await heroSize({ text: "00:00" }, 80, 40)).toEqual({ width: 60, height: 11 });
  // ...and at 62 columns it falls back rather than running off the side.
  const narrow = await heroSize({ text: "00:00" });
  expect(narrow.width).toBeLessThanOrEqual(62 - 7);
  expect(narrow.height).toBeLessThan(11);
});

test("an applet that pins a figlet keeps it — until it doesn't fit", async () => {
  withConfig(`[theme]\nfont = "tiny"\n`);
  // A pinned font wins over the theme's: the applet asked for these metrics.
  expect(await heroSize({ text: "00:00", font: "block" })).toEqual({ width: 43, height: 6 });
  // The pane still wins over the pin — an overflowing hero helps nobody.
  expect((await heroSize({ text: "00:00", font: "block" }, 40, 30)).width).toBeLessThanOrEqual(40 - 7);
});

test("fitBigFont shrinks, and only shrinks", () => {
  // Fits: the answer is the font that was asked for.
  expect(fitBigFont("kona", "huge", { width: 80 })).toBe("huge");
  expect(fitBigFont("kona", "tiny", { width: 80 })).toBe("tiny");
  // Doesn't fit: something smaller, never something bigger.
  for (const font of BIG_FONTS) {
    const asked = bigSize("00:00", font);
    const got = bigSize("00:00", fitBigFont("00:00", font, { width: 30 }));
    expect(got.width).toBeLessThanOrEqual(asked.width);
    expect(got.height).toBeLessThanOrEqual(asked.height);
  }
  expect(fitBigFont("00:00", "huge", { width: 30 })).toBe("shade");
  expect(fitBigFont("00:00", "block", { height: 3 })).toBe("tiny");
  // Nothing fits at all: the smallest, clipped, beats nothing on screen.
  expect(fitBigFont("00:00", "huge", { width: 4 })).toBe("tiny");
  expect(bigFits("00:00", "tiny", { width: 4 })).toBe(false);
});

test("every preset names a figlet the host can draw", () => {
  for (const preset of THEME_PRESETS) {
    expect(isBigFont(preset.theme.font)).toBe(true);
  }
  // ...and they are not all the same one — a theme is a face as well as a palette.
  expect(new Set(THEME_PRESETS.map((p) => p.theme.font)).size).toBeGreaterThan(3);
});

test("[theme] font wins over the preset's, and a bogus one is a complaint", () => {
  withConfig(`[theme]\npreset = "dracula"\nfont = "grid"\n`);
  expect(loadConfig().errors).toEqual([]);
  expect(theme().font).toBe("grid");
  expect(loadConfig().themeOverrides).toEqual({ font: "grid" });

  withConfig(`[theme]\nfont = "comic-sans"\n`);
  const cfg = loadConfig();
  expect(cfg.theme.font).toBe("block"); // the default still stands
  expect(cfg.errors.join(" ")).toContain("comic-sans");
  expect(cfg.errors.join(" ")).toContain("theme.font");
});
