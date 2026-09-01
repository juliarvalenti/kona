import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Color } from "../sdk/index.ts";

/**
 * kona config — one file, `~/.config/kona/config.toml`, that owns the palette,
 * the applet a bare `kona` opens, and per-applet settings.
 *
 * Everything here is OPTIONAL: with no file at all you get the defaults below,
 * which are exactly what kona shipped with before this file existed. A missing
 * key falls back to its default; a malformed one is ignored and recorded in
 * `errors` (surfaced by `kona config`) rather than crashing the TUI.
 *
 *   default = "dash"          # bare `kona` opens this applet (omit -> launcher)
 *
 *   [theme]
 *   accent = "#7aa2f7"
 *   ok     = "#00d488"
 *
 *   [applets.spotify]
 *   accent = "#1db954"        # per-applet frame tint
 *
 *   [applets.timer]
 *   default = "5m"            # `kona timer` with no argument
 *
 *   plugins = ["~/src/kona-plugins"]   # load applets from outside the repo
 *
 * Reading is synchronous and memoized, so any module can ask for the theme at
 * render time without threading config through every call. Tests point
 * KONA_CONFIG_DIR at a throwaway dir and call resetConfig().
 */

/**
 * The semantic palette. Applets name a ROLE, never a hex — that is what makes
 * one config file able to retheme every applet at once.
 */
export interface Theme {
  /** Primary tint: frame borders, selection fills, links. */
  accent: Color;
  /** Secondary tint, for a second series or a heading that isn't the accent. */
  alt: Color;
  /** Default foreground text. */
  fg: Color;
  /** De-emphasized text (labels, hints, empty states). */
  dim: Color;
  /** Inactive/idle — dimmer than `dim`. */
  muted: Color;
  /** Success / running / unread. */
  ok: Color;
  /** Caution — degraded, paused, rate-limited. */
  warn: Color;
  /** Failure. */
  error: Color;
  /** Keybind glyphs in the hint bar. */
  key: Color;
  /** Text drawn ON an accent fill (the selected record row). */
  bg: Color;
  /** Text-field trough (the fill behind an unfocused input). */
  field: Color;
  /** Text-field trough while it holds the keyboard — brighter than `field`. */
  fieldFocus: Color;
  /** The caret cell inside a focused field / search bar. */
  caret: Color;
  /** Text drawn ON the caret cell. */
  caretFg: Color;
  /** Opaque fill for chrome that must hide what's behind it (scrim, panels). */
  panel: Color;
}

export const DEFAULT_THEME: Theme = {
  accent: "#7aa2f7",
  alt: "#bb9af7",
  fg: "#d0d0d0",
  dim: "#6a6a6a",
  muted: "#5a5a5a",
  ok: "#00d488",
  warn: "#f0b000",
  error: "#ff5c57",
  key: "#e6e6e6",
  bg: "#0b0b0b",
  field: "#20222c",
  fieldFocus: "#2b2e3d",
  caret: "#7aa2f7",
  caretFg: "#0b0b0b",
  panel: "#0d0d12",
};

const THEME_ROLES = Object.keys(DEFAULT_THEME) as (keyof Theme)[];

export interface KonaConfig {
  /** Applet a bare `kona` opens. null = show the launcher. */
  defaultApplet: string | null;
  theme: Theme;
  /** Raw `[applets.<id>]` blocks, keyed by applet id. */
  applets: Record<string, Record<string, unknown>>;
  /**
   * Extra places to load applets from — a plugin package (a dir with an
   * `index.ts`) or a dir full of them. `~` expands. See core/load.ts.
   */
  plugins: string[];
  /** Absolute path we read (or would read). */
  path: string;
  /** True when that file exists — everything else is then defaults. */
  exists: boolean;
  /** Human-readable complaints about the file; never thrown. */
  errors: string[];
}

/** `~/.config/kona` (honors XDG_CONFIG_HOME; KONA_CONFIG_DIR overrides both). */
export function configDir(): string {
  return (
    process.env.KONA_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kona")
  );
}

export function configPath(): string {
  return join(configDir(), "config.toml");
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Turn a parsed TOML document into a KonaConfig. Pure — the file reading lives
 * in loadConfig(); this is what the tests exercise directly.
 */
export function resolveConfig(raw: unknown, meta: { path: string; exists: boolean }): KonaConfig {
  const errors: string[] = [];
  const doc = isTable(raw) ? raw : {};
  if (!isTable(raw) && raw !== undefined) errors.push("config root must be a table");

  // --- theme
  const theme: Theme = { ...DEFAULT_THEME };
  const rawTheme = doc.theme;
  if (rawTheme !== undefined && !isTable(rawTheme)) {
    errors.push("[theme] must be a table");
  } else if (isTable(rawTheme)) {
    for (const [role, value] of Object.entries(rawTheme)) {
      if (!THEME_ROLES.includes(role as keyof Theme)) {
        errors.push(`theme.${role}: unknown role (have: ${THEME_ROLES.join(", ")})`);
        continue;
      }
      if (typeof value !== "string" || !HEX.test(value)) {
        errors.push(`theme.${role}: not a hex color (got ${JSON.stringify(value)})`);
        continue;
      }
      theme[role as keyof Theme] = value;
    }
  }

  // --- default applet
  let defaultApplet: string | null = null;
  const rawDefault = doc.default;
  if (rawDefault !== undefined) {
    if (typeof rawDefault === "string" && rawDefault.trim()) defaultApplet = rawDefault.trim();
    else errors.push(`default: must be an applet id (got ${JSON.stringify(rawDefault)})`);
  }

  // --- per-applet blocks
  const applets: Record<string, Record<string, unknown>> = {};
  const rawApplets = doc.applets;
  if (rawApplets !== undefined && !isTable(rawApplets)) {
    errors.push("[applets] must be a table");
  } else if (isTable(rawApplets)) {
    for (const [id, block] of Object.entries(rawApplets)) {
      if (!isTable(block)) {
        errors.push(`[applets.${id}] must be a table`);
        continue;
      }
      if (block.accent !== undefined && (typeof block.accent !== "string" || !HEX.test(block.accent))) {
        errors.push(`applets.${id}.accent: not a hex color (got ${JSON.stringify(block.accent)})`);
        delete block.accent;
      }
      applets[id] = block;
    }
  }

  // --- external plugin roots
  const plugins: string[] = [];
  const rawPlugins = doc.plugins;
  if (rawPlugins !== undefined) {
    if (!Array.isArray(rawPlugins)) {
      errors.push(`plugins: must be a list of paths (got ${JSON.stringify(rawPlugins)})`);
    } else {
      for (const entry of rawPlugins) {
        if (typeof entry === "string" && entry.trim()) plugins.push(entry.trim());
        else errors.push(`plugins: not a path (got ${JSON.stringify(entry)})`);
      }
    }
  }

  return { defaultApplet, theme, applets, plugins, path: meta.path, exists: meta.exists, errors };
}

let cached: KonaConfig | null = null;

/** Read + memoize the config. Safe to call from anywhere, any number of times. */
export function loadConfig(): KonaConfig {
  if (cached) return cached;
  const path = configPath();
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null; // absent (or unreadable) -> defaults
  }
  if (text === null) return (cached = resolveConfig(undefined, { path, exists: false }));
  try {
    cached = resolveConfig(Bun.TOML.parse(text), { path, exists: true });
  } catch (e) {
    cached = resolveConfig(undefined, { path, exists: true });
    cached.errors.push(`could not parse TOML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return cached;
}

/** Drop the memoized config — for tests, and after writing the file. */
export function resetConfig(): void {
  cached = null;
}

/** The palette. This is the call sites' entry point; never hardcode a hex. */
export function theme(): Theme {
  return loadConfig().theme;
}

/** The `[applets.<id>]` block, or an empty table. */
export function appletConfig(id: string): Record<string, unknown> {
  return loadConfig().applets[id] ?? {};
}

/**
 * An applet's frame tint: `[applets.<id>].accent` if set, else the applet's own
 * default (its brand color, or a theme role).
 */
export function appletAccent(id: string, fallback: Color): Color {
  const v = appletConfig(id).accent;
  return typeof v === "string" ? v : fallback;
}

/** A string setting from an applet's block. */
export function appletString(id: string, key: string, fallback: string): string {
  const v = appletConfig(id)[key];
  return typeof v === "string" ? v : fallback;
}

/** A positive-number setting from an applet's block. */
export function appletNumber(id: string, key: string, fallback: number): number {
  const v = appletConfig(id)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * A boolean setting from an applet's block. TOML `true`/`false`, and the
 * strings people type anyway ("yes", "off"), both count.
 */
export function appletBool(id: string, key: string, fallback: boolean): boolean {
  const v = appletConfig(id)[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^(true|yes|on|1)$/i.test(v.trim())) return true;
    if (/^(false|no|off|0)$/i.test(v.trim())) return false;
  }
  return fallback;
}

/**
 * The commented starter file `kona config init` writes.
 *
 * The per-applet half is NOT listed here: each applet ships its own commented
 * block as `configSample` in its `defineApplet`, and the caller passes them in
 * (see `kona config init`). Adding an applet therefore never edits this file.
 */
export function defaultConfigToml(appletBlocks: string[] = []): string {
  const blocks = appletBlocks.map((b) => b.trim()).filter(Boolean);
  const applets = blocks.length
    ? `
# Per-applet settings. \`accent\` (frame + launcher row) and \`icon\` (its glyph
# in the launcher) work for any applet; the rest are the applet's own knobs,
# declared by the applet itself.
${blocks.join("\n\n")}
`
    : "";
  return `# kona — ~/.config/kona/config.toml
# Every key is optional; delete a line to fall back to the default shown.

# Applet a bare \`kona\` opens. Comment out for the "pick an app" launcher.
# default = "dash"

# Load applets from outside the repo: a plugin package (a dir with index.ts)
# or a dir full of them. \`~/.config/kona/plugins/*\` is always scanned.
# plugins = ["~/src/my-kona-applet"]

# The palette. Applets name ROLES, so these ten colors retheme all of kona.
[theme]
accent = "${DEFAULT_THEME.accent}"  # frames, selection, links
alt    = "${DEFAULT_THEME.alt}"  # secondary tint
fg     = "${DEFAULT_THEME.fg}"  # body text
dim    = "${DEFAULT_THEME.dim}"  # labels, hints
muted  = "${DEFAULT_THEME.muted}"  # idle / inactive
ok     = "${DEFAULT_THEME.ok}"  # running, unread, success
warn   = "${DEFAULT_THEME.warn}"  # paused, degraded
error  = "${DEFAULT_THEME.error}"  # failure
key    = "${DEFAULT_THEME.key}"  # keybind glyphs
bg     = "${DEFAULT_THEME.bg}"  # text on an accent fill
${applets}`;
}
