import type { Color } from "../sdk/index.ts";
import type { Theme } from "./config.ts";
import { DEFAULT_FONT, type BigFont } from "./fonts.ts";

/**
 * Named theme presets — the palettes people already know (Catppuccin, Nord,
 * Dracula, …) mapped onto kona's semantic roles.
 *
 * A preset is a BASE, not a lock: `[theme] preset = "nord"` in
 * `~/.config/kona/config.toml` picks one and any explicit role in that same
 * block still wins on top (see core/config.ts). The `theme` applet writes that
 * one key, so the picker and a hand-edited config are the same setting.
 *
 * A preset also picks a FIGLET — the typeface hero displays are lettered in
 * (`theme().font`, core/fonts.ts) — because a palette sets a vibe and a display
 * face sets the same one: a chunky theme leans `huge`, a minimal one `tiny`.
 * Switching preset therefore reskins and re-letters in one keystroke, and
 * `[theme] font` in the config still wins over the preset's choice.
 *
 * Every preset goes through `roles()` below, which is the point of the
 * intermediate `Scheme` shape: a scheme names the handful of colors a palette
 * actually publishes (a ground, two troughs, three text weights, five hues) and
 * one function spreads them over ALL of kona's roles. A preset therefore cannot
 * ship with a muddy code block or an invisible caret because its author only
 * thought about `fg` and `accent` — there is nowhere to forget a role.
 */

/**
 * A scheme as its publisher describes it. Everything here is a real color from
 * the upstream palette; the mapping to kona's roles happens once, in `roles()`.
 */
interface Scheme {
  /** Display name, e.g. "Catppuccin Mocha". */
  label: string;
  /** Dark ground? Drives nothing but the picker's grouping. */
  dark: boolean;
  /** The window ground. Also what text ON an accent fill is drawn in. */
  bg: Color;
  /** Opaque chrome fill (scrim, panels). Defaults to `bg`. */
  panel?: Color;
  /** The first surface above the ground: input troughs, code blocks. */
  field: Color;
  /** The surface above that — a field holding the keyboard. */
  fieldFocus: Color;
  /** Body text. */
  fg: Color;
  /** Brighter than body text, for keybind glyphs. Defaults to `fg`. */
  bright?: Color;
  /** De-emphasized text: labels, hints. */
  dim: Color;
  /** Fainter still: idle, inactive, empty states. */
  muted: Color;
  /** Primary tint — frames, selection, links. */
  accent: Color;
  /** Secondary tint. */
  alt: Color;
  ok: Color;
  warn: Color;
  error: Color;
  /** The figlet its heroes are lettered in. Defaults to kona's own, `block`. */
  font?: BigFont;
}

/** Spread a scheme over every kona role. The only place that mapping lives. */
function roles(s: Scheme): Theme {
  return {
    accent: s.accent,
    alt: s.alt,
    fg: s.fg,
    dim: s.dim,
    muted: s.muted,
    ok: s.ok,
    warn: s.warn,
    error: s.error,
    key: s.bright ?? s.fg,
    // Text on an accent fill, and the cell under the caret, are both "the
    // ground, on top of a hue" — which is exactly what the scheme's bg is.
    bg: s.bg,
    field: s.field,
    fieldFocus: s.fieldFocus,
    caret: s.accent,
    caretFg: s.bg,
    panel: s.panel ?? s.bg,
    font: s.font ?? DEFAULT_FONT,
  };
}

/** A preset as everything downstream sees it: an id, a name, and a palette. */
export interface ThemePreset {
  /** The id `[theme] preset = "…"` and `theme.set` take, e.g. "nord". */
  id: string;
  label: string;
  dark: boolean;
  theme: Theme;
}

/**
 * kona's own palette — the default, and the one the shots are rendered in.
 * `DEFAULT_THEME` in core/config.ts is this preset, so "no preset" and
 * `preset = "kona-aloha"` resolve to the same colors.
 */
const SCHEMES: Record<string, Scheme> = {
  "kona-aloha": {
    label: "kona aloha 🌺",
    dark: true,
    bg: "#0b0b0b",
    panel: "#0d0d12",
    field: "#20222c",
    fieldFocus: "#2b2e3d",
    fg: "#d0d0d0",
    bright: "#e6e6e6",
    dim: "#6a6a6a",
    muted: "#5a5a5a",
    accent: "#7aa2f7",
    alt: "#bb9af7",
    ok: "#00d488",
    warn: "#f0b000",
    error: "#ff5c57",
    font: "block", // kona's own
  },

  // --- Catppuccin (base/mantle/surface + the four accents kona needs)
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    dark: false,
    bg: "#eff1f5",
    panel: "#e6e9ef",
    field: "#e6e9ef",
    fieldFocus: "#dce0e8",
    fg: "#4c4f69",
    bright: "#4c4f69",
    dim: "#6c6f85",
    muted: "#8c8fa1",
    accent: "#1e66f5",
    alt: "#8839ef",
    ok: "#40a02b",
    warn: "#df8e1d",
    error: "#d20f39",
    font: "slick", // pastel, rounded
  },
  "catppuccin-frappe": {
    label: "Catppuccin Frappé",
    dark: true,
    bg: "#303446",
    panel: "#292c3c",
    field: "#414559",
    fieldFocus: "#51576d",
    fg: "#c6d0f5",
    bright: "#f2d5cf",
    dim: "#a5adce",
    muted: "#838ba7",
    accent: "#8caaee",
    alt: "#ca9ee6",
    ok: "#a6d189",
    warn: "#e5c890",
    error: "#e78284",
    font: "slick",
  },
  "catppuccin-macchiato": {
    label: "Catppuccin Macchiato",
    dark: true,
    bg: "#24273a",
    panel: "#1e2030",
    field: "#363a4f",
    fieldFocus: "#494d64",
    fg: "#cad3f5",
    bright: "#f4dbd6",
    dim: "#a5adcb",
    muted: "#8087a2",
    accent: "#8aadf4",
    alt: "#c6a0f6",
    ok: "#a6da95",
    warn: "#eed49f",
    error: "#ed8796",
    font: "slick",
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    dark: true,
    bg: "#1e1e2e",
    panel: "#181825",
    field: "#313244",
    fieldFocus: "#45475a",
    fg: "#cdd6f4",
    bright: "#f5e0dc",
    dim: "#a6adc8",
    muted: "#7f849c",
    accent: "#89b4fa",
    alt: "#cba6f7",
    ok: "#a6e3a1",
    warn: "#f9e2af",
    error: "#f38ba8",
    font: "slick",
  },

  // --- the classics
  nord: {
    label: "Nord",
    dark: true,
    bg: "#2e3440",
    panel: "#272c36",
    field: "#3b4252",
    fieldFocus: "#434c5e",
    fg: "#d8dee9",
    bright: "#eceff4",
    dim: "#a0aabb",
    muted: "#7b88a1",
    accent: "#88c0d0",
    alt: "#b48ead",
    ok: "#a3be8c",
    warn: "#ebcb8b",
    error: "#bf616a",
    font: "grid", // cool and technical
  },
  dracula: {
    label: "Dracula",
    dark: true,
    bg: "#282a36",
    panel: "#21222c",
    field: "#343746",
    fieldFocus: "#44475a",
    fg: "#f8f8f2",
    bright: "#ffffff",
    dim: "#9aa3c4",
    muted: "#6272a4",
    accent: "#bd93f9",
    alt: "#ff79c6",
    ok: "#50fa7b",
    warn: "#ffb86c",
    error: "#ff5555",
    font: "huge", // theatrical
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    dark: true,
    bg: "#282828",
    panel: "#1d2021",
    field: "#3c3836",
    fieldFocus: "#504945",
    fg: "#ebdbb2",
    bright: "#fbf1c7",
    dim: "#a89984",
    muted: "#928374",
    accent: "#83a598",
    alt: "#d3869b",
    ok: "#b8bb26",
    warn: "#fabd2f",
    error: "#fb4934",
    font: "shade", // retro dither
  },
  "gruvbox-light": {
    label: "Gruvbox Light",
    dark: false,
    bg: "#fbf1c7",
    panel: "#f9f5d7",
    field: "#ebdbb2",
    fieldFocus: "#d5c4a1",
    fg: "#3c3836",
    bright: "#282828",
    dim: "#7c6f64",
    muted: "#928374",
    accent: "#076678",
    alt: "#8f3f71",
    ok: "#79740e",
    warn: "#b57614",
    error: "#9d0006",
    font: "shade",
  },
  "tokyo-night": {
    label: "Tokyo Night",
    dark: true,
    bg: "#1a1b26",
    panel: "#16161e",
    field: "#24283b",
    fieldFocus: "#292e42",
    fg: "#c0caf5",
    bright: "#ffffff",
    dim: "#a9b1d6",
    muted: "#565f89",
    accent: "#7aa2f7",
    alt: "#bb9af7",
    ok: "#9ece6a",
    warn: "#e0af68",
    error: "#f7768e",
    font: "block",
  },
  "rose-pine": {
    label: "Rosé Pine",
    dark: true,
    bg: "#191724",
    panel: "#1f1d2e",
    field: "#1f1d2e",
    fieldFocus: "#26233a",
    fg: "#e0def4",
    bright: "#ffffff",
    dim: "#908caa",
    muted: "#6e6a86",
    accent: "#9ccfd8",
    alt: "#c4a7e7",
    ok: "#31748f",
    warn: "#f6c177",
    error: "#eb6f92",
    font: "pallet", // elegant line work
  },
  "rose-pine-moon": {
    label: "Rosé Pine Moon",
    dark: true,
    bg: "#232136",
    panel: "#2a273f",
    field: "#2a273f",
    fieldFocus: "#393552",
    fg: "#e0def4",
    bright: "#ffffff",
    dim: "#908caa",
    muted: "#6e6a86",
    accent: "#9ccfd8",
    alt: "#c4a7e7",
    ok: "#3e8fb0",
    warn: "#f6c177",
    error: "#eb6f92",
    font: "pallet",
  },
  "rose-pine-dawn": {
    label: "Rosé Pine Dawn",
    dark: false,
    bg: "#faf4ed",
    panel: "#fffaf3",
    field: "#fffaf3",
    fieldFocus: "#f2e9e1",
    fg: "#575279",
    bright: "#403d52",
    dim: "#797593",
    muted: "#9893a5",
    accent: "#286983",
    alt: "#907aa9",
    ok: "#56949f",
    warn: "#ea9d34",
    error: "#b4637a",
    font: "tiny", // airy
  },
  "solarized-dark": {
    label: "Solarized Dark",
    dark: true,
    bg: "#002b36",
    panel: "#00222b",
    field: "#073642",
    fieldFocus: "#0b4653",
    fg: "#93a1a1",
    bright: "#eee8d5",
    dim: "#839496",
    muted: "#586e75",
    accent: "#268bd2",
    alt: "#6c71c4",
    ok: "#859900",
    warn: "#b58900",
    error: "#dc322f",
    font: "pallet",
  },
  "solarized-light": {
    label: "Solarized Light",
    dark: false,
    bg: "#fdf6e3",
    panel: "#f5eedb",
    field: "#eee8d5",
    fieldFocus: "#e4ddc8",
    fg: "#586e75",
    bright: "#073642",
    dim: "#657b83",
    muted: "#93a1a1",
    accent: "#268bd2",
    alt: "#6c71c4",
    ok: "#859900",
    warn: "#b58900",
    error: "#dc322f",
    font: "tiny",
  },
  everforest: {
    label: "Everforest Dark",
    dark: true,
    bg: "#2d353b",
    panel: "#272e33",
    field: "#343f44",
    fieldFocus: "#3d484d",
    fg: "#d3c6aa",
    bright: "#e9e0c6",
    dim: "#9da9a0",
    muted: "#7a8478",
    accent: "#a7c080",
    alt: "#d699b6",
    ok: "#83c092",
    warn: "#dbbc7f",
    error: "#e67e80",
    font: "shade",
  },
  kanagawa: {
    label: "Kanagawa Wave",
    dark: true,
    bg: "#1f1f28",
    panel: "#16161d",
    field: "#2a2a37",
    fieldFocus: "#363646",
    fg: "#dcd7ba",
    bright: "#c8c093",
    dim: "#9a9791",
    muted: "#727169",
    accent: "#7e9cd8",
    alt: "#957fb8",
    ok: "#98bb6c",
    warn: "#e6c384",
    error: "#e82424",
    font: "grid",
  },
  "one-dark": {
    label: "One Dark",
    dark: true,
    bg: "#282c34",
    panel: "#21252b",
    field: "#2c313a",
    fieldFocus: "#3e4451",
    fg: "#abb2bf",
    bright: "#dcdfe4",
    dim: "#7f848e",
    muted: "#5c6370",
    accent: "#61afef",
    alt: "#c678dd",
    ok: "#98c379",
    warn: "#e5c07b",
    error: "#e06c75",
    font: "block",
  },
  "ayu-dark": {
    label: "Ayu Dark",
    dark: true,
    bg: "#0b0e14",
    panel: "#0d1017",
    field: "#131721",
    fieldFocus: "#1b2029",
    fg: "#bfbdb6",
    bright: "#e6e1cf",
    dim: "#8a8986",
    muted: "#565b66",
    accent: "#e6b450",
    alt: "#d2a6ff",
    ok: "#aad94c",
    warn: "#ffb454",
    error: "#f07178",
    font: "grid",
  },
  "ayu-mirage": {
    label: "Ayu Mirage",
    dark: true,
    bg: "#1f2430",
    panel: "#1a1f29",
    field: "#242936",
    fieldFocus: "#2d3440",
    fg: "#cccac2",
    bright: "#eaeae5",
    dim: "#9a9992",
    muted: "#707a8c",
    accent: "#ffcc66",
    alt: "#dfbfff",
    ok: "#d5ff80",
    warn: "#ffad66",
    error: "#f28779",
    font: "grid",
  },
  "ayu-light": {
    label: "Ayu Light",
    dark: false,
    bg: "#fcfcfc",
    panel: "#f8f9fa",
    field: "#f0f0f0",
    fieldFocus: "#e7e8e9",
    fg: "#5c6166",
    bright: "#3b4045",
    dim: "#787b80",
    muted: "#8a9199",
    accent: "#ff9940",
    alt: "#a37acc",
    ok: "#86b300",
    warn: "#f2ae49",
    error: "#e65050",
    font: "tiny",
  },
};

/** The default preset's id — kona's own palette, and what the shots pin. */
export const DEFAULT_PRESET = "kona-aloha";

/**
 * Every preset, in a deliberate order: kona first, then the families in the
 * order people tend to name them. The picker lists them exactly like this.
 */
export const THEME_PRESETS: ThemePreset[] = Object.entries(SCHEMES).map(([id, scheme]) => ({
  id,
  label: scheme.label,
  dark: scheme.dark,
  theme: roles(scheme),
}));

const BY_ID = new Map(THEME_PRESETS.map((p) => [p.id, p]));

/** The preset with this id, or null. Ids are exact — the CLI resolves fuzzily. */
export function themePreset(id: string): ThemePreset | null {
  return BY_ID.get(id) ?? null;
}

/** Every preset id, in list order. */
export function presetIds(): string[] {
  return THEME_PRESETS.map((p) => p.id);
}

/**
 * Resolve whatever someone typed to a preset id: the id itself, its label, or
 * an unambiguous prefix ("mocha" -> catppuccin-mocha, "nor" -> nord). Returns
 * null when nothing matches, and when more than one thing does — a picker that
 * guesses between Catppuccin Latte and Ayu Light is worse than one that asks.
 */
export function resolvePreset(input: string): string | null {
  const q = input.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!q) return null;
  if (BY_ID.has(q)) return q;
  const byLabel = THEME_PRESETS.find((p) => p.label.toLowerCase() === input.trim().toLowerCase());
  if (byLabel) return byLabel.id;
  const hits = THEME_PRESETS.filter((p) => p.id.includes(q) || p.label.toLowerCase().includes(q));
  return hits.length === 1 ? hits[0]!.id : null;
}
