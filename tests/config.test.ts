import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THEME,
  appletAccent,
  appletConfig,
  appletNumber,
  appletString,
  configPath,
  loadConfig,
  resetConfig,
  resolveConfig,
  theme,
  defaultConfigToml,
} from "../core/config.ts";
import { recordRow } from "../sdk/components.ts";
import timer from "../applets/timer/index.ts";
import spotify from "../applets/spotify/index.ts";

/**
 * Config + theming. The file is optional and user-written, so the contract is:
 * absent or malformed -> the shipped defaults, complaints collected in
 * `errors`, and never a throw that takes the TUI down with it.
 */

const dirs: string[] = [];
const prevDir = process.env.KONA_CONFIG_DIR;

/** Point config resolution at a throwaway dir holding this TOML (or nothing). */
function withConfig(toml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kona-config-"));
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

test("no config file — full defaults, no errors", () => {
  const dir = withConfig();
  const cfg = loadConfig();
  expect(cfg.exists).toBe(false);
  expect(cfg.path).toBe(join(dir, "config.toml"));
  expect(cfg.defaultApplet).toBeNull();
  expect(cfg.theme).toEqual(DEFAULT_THEME);
  expect(cfg.applets).toEqual({});
  expect(cfg.errors).toEqual([]);
});

test("KONA_CONFIG_DIR wins over XDG_CONFIG_HOME", () => {
  const dir = withConfig();
  expect(configPath()).toBe(join(dir, "config.toml"));
});

test("reads the palette, the default applet, and per-applet blocks", () => {
  withConfig(`
default = "dash"

[theme]
accent = "#ff00ff"
ok = "#0f0"

[applets.spotify]
accent = "#123456"

[applets.timer]
default = "12m"

[applets.email]
page = 50
`);
  const cfg = loadConfig();
  expect(cfg.exists).toBe(true);
  expect(cfg.errors).toEqual([]);
  expect(cfg.defaultApplet).toBe("dash");
  expect(cfg.theme.accent).toBe("#ff00ff");
  expect(cfg.theme.ok).toBe("#0f0");
  // untouched roles keep their defaults
  expect(cfg.theme.dim).toBe(DEFAULT_THEME.dim);
  expect(appletConfig("spotify")).toEqual({ accent: "#123456" });
  expect(appletAccent("spotify", "#1db954")).toBe("#123456");
  expect(appletString("timer", "default", "")).toBe("12m");
  expect(appletNumber("email", "page", 20)).toBe(50);
});

test("[applets.timer.pomodoro] shapes the cycle a session starts under", () => {
  withConfig(`[applets.timer.pomodoro]
work  = "50m"
short = 10        # a bare number is MINUTES
long  = "20m"
every = 3
auto  = false
`);
  const state = structuredClone(timer.initialState);
  const started = timer.verbs["pomodoro.start"]!({}, { state, emit: () => {} }) as {
    remaining: number;
    rounds: number;
  };
  expect(started.remaining).toBe(3000); // 50m of work
  expect(started.rounds).toBe(3);
  expect(state.pomodoro.plan).toEqual({ work: 3000, short: 600, long: 1200, every: 3, auto: false });
});

test("a malformed pomodoro block falls back to the classic 25/5/15", () => {
  withConfig(`[applets.timer]\npomodoro = "yes please"\n`);
  const state = structuredClone(timer.initialState);
  timer.verbs["pomodoro.start"]!({}, { state, emit: () => {} });
  expect(state.pomodoro.plan).toEqual({ work: 1500, short: 300, long: 900, every: 4, auto: true });
});

test("unset applet settings fall back to the caller's default", () => {
  withConfig(`[applets.spotify]\naccent = "#123456"\n`);
  expect(appletAccent("dash", "#1db954")).toBe("#1db954");
  expect(appletString("timer", "default", "5m")).toBe("5m");
  expect(appletNumber("email", "page", 20)).toBe(20);
  expect(appletConfig("nope")).toEqual({});
});

test("bad values are ignored and reported, never thrown", () => {
  withConfig(`
default = 7

[theme]
accent = "not-a-color"
nonsense = "#ffffff"
dim = "#111111"

[applets.spotify]
accent = "green"
`);
  const cfg = loadConfig();
  expect(cfg.theme.accent).toBe(DEFAULT_THEME.accent); // rejected
  expect(cfg.theme.dim).toBe("#111111"); // the good key still applies
  expect(cfg.defaultApplet).toBeNull();
  expect(cfg.applets.spotify?.accent).toBeUndefined();
  expect(appletAccent("spotify", "#1db954")).toBe("#1db954");
  expect(cfg.errors.join("\n")).toContain("theme.accent");
  expect(cfg.errors.join("\n")).toContain("theme.nonsense");
  expect(cfg.errors.join("\n")).toContain("default");
  expect(cfg.errors.join("\n")).toContain("applets.spotify.accent");
});

test("malformed TOML falls back to defaults and says so", () => {
  withConfig("this is not = = toml [[[");
  const cfg = loadConfig();
  expect(cfg.exists).toBe(true);
  expect(cfg.theme).toEqual(DEFAULT_THEME);
  expect(cfg.errors.join("\n")).toContain("could not parse TOML");
});

test("wrong shapes for [theme] / [applets] are reported, not fatal", () => {
  const cfg = resolveConfig({ theme: "blue", applets: { timer: 3 } }, { path: "/x", exists: true });
  expect(cfg.theme).toEqual(DEFAULT_THEME);
  expect(cfg.applets).toEqual({});
  expect(cfg.errors).toHaveLength(2);
});

test("the shipped starter file parses to the shipped defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "kona-config-"));
  dirs.push(dir);
  // The applet half of the starter file is contributed by the applets
  // themselves (`configSample`), exactly as `kona config init` composes it.
  writeFileSync(join(dir, "config.toml"), defaultConfigToml([spotify.configSample!, timer.configSample!]));
  process.env.KONA_CONFIG_DIR = dir;
  resetConfig();
  const cfg = loadConfig();
  expect(cfg.errors).toEqual([]);
  expect(cfg.theme).toEqual(DEFAULT_THEME);
  expect(cfg.defaultApplet).toBeNull(); // `default` ships commented out
  expect(cfg.plugins).toEqual([]); // ...and so does `plugins`
  expect(cfg.applets.spotify?.accent).toBe("#1db954");
  expect(cfg.applets.timer?.default).toBe("5m");
});

test("a themed palette reaches applets and components", () => {
  withConfig(`[theme]\nok = "#abcdef"\nmuted = "#010101"\nbg = "#fedcba"\naccent = "#222222"\n`);
  expect(theme().ok).toBe("#abcdef");

  // the timer paints from roles, so retheming retints it (over the selected timer)
  expect(timer.accent!({ timers: [], cursor: 0 })).toBe("#010101"); // muted: nothing selected
  const running = { id: "t1", label: "", remaining: 30, total: 30, running: true };
  expect(timer.accent!({ timers: [running], cursor: 0 })).toBe("#abcdef");

  // a selected record row draws `bg` on the theme accent
  expect(recordRow([{ text: "row", grow: true }], { width: 20, selected: true })).toMatchObject({
    color: "#fedcba",
    bg: "#222222",
  });
});
