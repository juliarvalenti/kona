import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Color } from "../sdk/index.ts";
import { BIG_FONTS, isBigFont, type BigFont } from "./fonts.ts";
import { DEFAULT_PRESET, themePreset, presetIds } from "./themes.ts";

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
 *   preset = "catppuccin-mocha"   # a named palette (core/themes.ts)
 *   accent = "#7aa2f7"            # ...and a role that wins over it
 *   ok     = "#00d488"
 *   font   = "huge"               # ...including the figlet heroes are set in
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
  /**
   * The figlet hero displays are lettered in — kona's display TYPEFACE, and
   * the one role here that isn't a color. A `big` node with no font of its own
   * gets this one, so a theme reskins AND re-letters (core/fonts.ts).
   */
  font: BigFont;
}

/**
 * kona's own palette, and the base every other preset is an alternative to.
 * It lives in the preset registry (core/themes.ts) as `kona-aloha`, so "no
 * config at all" and `preset = "kona-aloha"` are the same colors by
 * construction rather than by two lists agreeing.
 */
export const DEFAULT_THEME: Theme = themePreset(DEFAULT_PRESET)!.theme;

const THEME_ROLES = Object.keys(DEFAULT_THEME) as (keyof Theme)[];
/** Every role but `font` — the ones a hex color is the right answer for. */
export const COLOR_ROLES = THEME_ROLES.filter((r) => r !== "font") as Exclude<keyof Theme, "font">[];

/**
 * `[security]` — the policy that decides which agent-fired verbs need a human.
 *
 * The default is the interesting one: an untrusted caller's `high` and
 * `critical` priority verbs are HELD (parked as a pending action for you to
 * approve), everything else runs. `hold` moves the line wholesale; `allow` and
 * `guard` move it one verb at a time and always win over `hold`.
 */
export interface SecurityConfig {
  /**
   * Which verbs an untrusted caller must ask about:
   *   - `"default"`     high + critical priority (the shipped policy).
   *   - `"all-writes"`  anything past a pure read/local (priority >= medium).
   *   - `"none"`        nothing — agents act freely (same as KONA_TRUST_AGENTS=1).
   */
  hold: SecurityHold;
  /** Verbs that run regardless — `"spotify.playPause"`, `"spotify.*"`, `"notes"`. */
  allow: string[];
  /** Verbs that are held regardless, same spellings. */
  guard: string[];
  /** How long a pending action waits for you before it is dropped. */
  expireMs: number;
}

export type SecurityHold = "default" | "all-writes" | "none";

const HOLDS: SecurityHold[] = ["default", "all-writes", "none"];

/** Ten minutes: long enough to walk back to the terminal, short enough to forget. */
export const DEFAULT_APPROVAL_EXPIRY_MS = 10 * 60_000;

export const DEFAULT_SECURITY: SecurityConfig = {
  hold: "default",
  allow: [],
  guard: [],
  expireMs: DEFAULT_APPROVAL_EXPIRY_MS,
};

/** `"90"` / `"90s"` / `"10m"` / `"1h"` -> ms. Null when it isn't a duration. */
function durationMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v * 1000 : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return n * scale;
}

/** A list-of-strings key, tolerating the bare string people type. */
function stringList(v: unknown, label: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) {
    errors.push(`${label}: must be a list of "<applet>.<verb>" names (got ${JSON.stringify(v)})`);
    return [];
  }
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else errors.push(`${label}: not a verb name (got ${JSON.stringify(entry)})`);
  }
  return out;
}

export interface KonaConfig {
  /** Applet a bare `kona` opens. null = show the launcher. */
  defaultApplet: string | null;
  /** The resolved palette: the preset, with any explicit role laid over it. */
  theme: Theme;
  /** Which named preset that palette started from (core/themes.ts). */
  preset: string;
  /** The roles the file named EXPLICITLY — what still wins over a new preset. */
  themeOverrides: Partial<Theme>;
  /** `[security]` — which agent-fired verbs need a human first. */
  security: SecurityConfig;
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

  // --- theme: a named preset is the BASE, explicit roles are laid over it, so
  // switching presets keeps the two colors you hand-picked.
  let preset = DEFAULT_PRESET;
  const themeOverrides: Partial<Theme> = {};
  const rawTheme = doc.theme;
  if (rawTheme !== undefined && !isTable(rawTheme)) {
    errors.push("[theme] must be a table");
  } else if (isTable(rawTheme)) {
    const rawPreset = rawTheme.preset;
    if (rawPreset !== undefined) {
      if (typeof rawPreset !== "string" || !themePreset(rawPreset)) {
        errors.push(`theme.preset: unknown preset ${JSON.stringify(rawPreset)} (have: ${presetIds().join(", ")})`);
      } else {
        preset = rawPreset;
      }
    }
    for (const [role, value] of Object.entries(rawTheme)) {
      if (role === "preset") continue;
      if (!THEME_ROLES.includes(role as keyof Theme)) {
        errors.push(`theme.${role}: unknown role (have: ${THEME_ROLES.join(", ")})`);
        continue;
      }
      // `font` is a role like any other — it just takes a figlet's name where
      // the rest take a hex.
      if (role === "font") {
        if (!isBigFont(value)) {
          errors.push(`theme.font: unknown figlet ${JSON.stringify(value)} (have: ${BIG_FONTS.join(", ")})`);
          continue;
        }
        themeOverrides.font = value;
        continue;
      }
      if (typeof value !== "string" || !HEX.test(value)) {
        errors.push(`theme.${role}: not a hex color (got ${JSON.stringify(value)})`);
        continue;
      }
      themeOverrides[role as Exclude<keyof Theme, "font">] = value;
    }
  }
  const theme: Theme = { ...themePreset(preset)!.theme, ...themeOverrides };

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

  // --- [security]: the human-in-the-loop policy for untrusted callers
  const security: SecurityConfig = { ...DEFAULT_SECURITY };
  const rawSecurity = doc.security;
  if (rawSecurity !== undefined && !isTable(rawSecurity)) {
    errors.push("[security] must be a table");
  } else if (isTable(rawSecurity)) {
    const rawHold = rawSecurity.hold;
    if (rawHold !== undefined) {
      if (typeof rawHold === "string" && HOLDS.includes(rawHold as SecurityHold)) {
        security.hold = rawHold as SecurityHold;
      } else {
        errors.push(`security.hold: must be one of ${HOLDS.join(", ")} (got ${JSON.stringify(rawHold)})`);
      }
    }
    security.allow = stringList(rawSecurity.allow, "security.allow", errors);
    security.guard = stringList(rawSecurity.guard, "security.guard", errors);
    if (rawSecurity.expire !== undefined) {
      const ms = durationMs(rawSecurity.expire);
      if (ms === null) errors.push(`security.expire: must be a duration like "10m" (got ${JSON.stringify(rawSecurity.expire)})`);
      else security.expireMs = ms;
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

  return {
    defaultApplet,
    theme,
    preset,
    themeOverrides,
    security,
    applets,
    plugins,
    path: meta.path,
    exists: meta.exists,
    errors,
  };
}

let cached: KonaConfig | null = null;
/** Fingerprint of the file behind `cached` ("" = no file), for refreshConfig. */
let cachedStamp = "";

/** Read + memoize the config. Safe to call from anywhere, any number of times. */
export function loadConfig(): KonaConfig {
  if (cached) return cached;
  const path = configPath();
  cachedStamp = stampOf(path);
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
  cachedStamp = "";
  override = null;
}

/**
 * A cheap fingerprint of the file: mtime AND size, because two writes inside
 * the same millisecond are a real thing when a verb saves a theme and the host
 * repaints in the same breath.
 */
function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return ""; // absent — and "absent" is itself a state worth noticing
  }
}

/**
 * Notice a config file that changed under us, cheaply enough to call once per
 * rendered frame: one stat, and a re-read only when the mtime moved. This is
 * what makes `kona theme` (or an editor) retint a RUNNING TUI — the host is a
 * separate process from the daemon that wrote the file, so neither one can
 * hand the other a fresh palette. Returns true when the config was reloaded.
 */
export function refreshConfig(): boolean {
  if (!cached) return false; // nothing memoized — the next read is fresh anyway
  const now = stampOf(cached.path);
  if (now === cachedStamp) return false;
  cached = null;
  loadConfig();
  return true;
}

/**
 * A palette that stands in for the configured one until it is cleared — how a
 * theme picker previews a preset LIVE, before anything is written to disk.
 * Set by the host from the open applet's `theme(state)`; nothing else should
 * touch it, and `resetConfig()` drops it with the rest of the memo.
 */
let override: Theme | null = null;

export function setThemeOverride(next: Partial<Theme> | null): void {
  override = next ? { ...loadConfig().theme, ...next } : null;
}

/** The palette the override is standing in for, if any. */
export function themeOverride(): Theme | null {
  return override;
}

/** The palette. This is the call sites' entry point; never hardcode a hex. */
export function theme(): Theme {
  return override ?? loadConfig().theme;
}

/**
 * The approval policy in force. Read at call time (like `theme()`), so editing
 * the config file changes what the running daemon holds without a restart.
 */
export function securityConfig(): SecurityConfig {
  return loadConfig().security;
}

/** The named preset the palette starts from. */
export function themePresetId(): string {
  return loadConfig().preset;
}

/**
 * Write `[theme] preset = "<id>"` into the config file, leaving everything
 * else — comments, per-applet blocks, hand-picked roles — exactly as it was.
 *
 * This is text surgery rather than a TOML round-trip on purpose: the file is
 * hand-written and mostly comments, and re-emitting it from a parsed document
 * would quietly eat them. Returns the path it wrote.
 */
export function writeThemePreset(id: string): string {
  if (!themePreset(id)) throw new Error(`unknown theme preset: ${id}`);
  const path = configPath();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = ""; // no file yet — we are about to write the first one
  }
  const line = `preset = "${id}"`;
  const header = /^[ \t]*\[theme\][ \t]*$/m.exec(text);
  if (!header) {
    const body = text.replace(/\s*$/, "");
    text = `${body ? `${body}\n\n` : ""}[theme]\n${line}\n`;
  } else {
    // Only this section's keys are ours to touch: a `preset = ...` under
    // [applets.foo] belongs to that applet.
    const start = header.index + header[0].length;
    const rest = text.slice(start);
    const next = /^[ \t]*\[/m.exec(rest);
    const end = next ? start + next.index : text.length;
    const section = text.slice(start, end);
    const existing = /^[ \t]*preset[ \t]*=.*$/m;
    const patched = existing.test(section)
      ? section.replace(existing, line)
      : `\n${line}${section.startsWith("\n") ? "" : "\n"}${section}`;
    text = text.slice(0, start) + patched + text.slice(end);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  resetConfig();
  return path;
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
 * A list-of-strings setting from an applet's block. A bare string counts as a
 * one-entry list, since `hide = "weather"` is what people type.
 */
export function appletList(id: string, key: string, fallback: string[] = []): string[] {
  const v = appletConfig(id)[key];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim());
  return fallback;
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

# Which agent-fired verbs need YOU first.
#
# Applets declare how much oversight each of their verbs needs — "low" (reads
# and kona-local state), "medium" (reversible remote effects), "high" (acts as
# you and commits) or "critical" (irreversible loss) — and this decides which
# of those an UNTRUSTED caller may fire on its own. The TUI is always trusted:
# you pressed the key. Anything held is parked in the \`approvals\` applet for
# you to approve or deny.
[security]
# hold = "default"                # hold high + critical (the default)
# hold = "all-writes"             # ...or anything past a read/local (>= medium)
# hold = "none"                   # ...or nothing (same as KONA_TRUST_AGENTS=1)
# allow = ["spotify.playPause"]   # these run regardless of the level rule
# guard = ["notes.clear"]         # ...and these are always held
# expire = "10m"                  # how long a pending action waits for you

# The palette AND the display typeface. \`preset\` picks a named one (\`kona
# theme\` lists them, and the \`theme\` applet previews them live); the roles
# below are kona's own defaults, and uncommenting one makes it win over
# whatever preset is in force.
[theme]
# preset = "catppuccin-mocha"
# font   = "${DEFAULT_THEME.font}"  # figlet for hero displays: ${BIG_FONTS.join(", ")}
# accent = "${DEFAULT_THEME.accent}"  # frames, selection, links
# alt    = "${DEFAULT_THEME.alt}"  # secondary tint
# fg     = "${DEFAULT_THEME.fg}"  # body text
# dim    = "${DEFAULT_THEME.dim}"  # labels, hints
# muted  = "${DEFAULT_THEME.muted}"  # idle / inactive
# ok     = "${DEFAULT_THEME.ok}"  # running, unread, success
# warn   = "${DEFAULT_THEME.warn}"  # paused, degraded
# error  = "${DEFAULT_THEME.error}"  # failure
# key    = "${DEFAULT_THEME.key}"  # keybind glyphs
# bg     = "${DEFAULT_THEME.bg}"  # text on an accent fill
${applets}`;
}
