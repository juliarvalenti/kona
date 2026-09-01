import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";

/**
 * Desktop notifications — the daemon's one outward-facing side effect.
 *
 * The dash is meant to be left open, but nobody stares at a terminal all day.
 * This is the ambient half: an applet's tick or verb calls notify() and the OS
 * banner does the rest. Because verbs run in the daemon regardless of who fired
 * them, an AGENT calling `timer.start` gets YOU a banner when it finishes — the
 * bimodal loop closed all the way out to the desktop.
 *
 * Three rules keep it from becoming spam:
 *   - opt-in per event  : every notification names an EVENTS key; the config
 *                         file (~/.config/kona/notify.json, `kona notify`) says
 *                         which are on. Unknown events are off.
 *   - dedupe            : same `key` inside `dedupeMs` is dropped, so a
 *                         re-listed PR or a re-synced inbox stays quiet.
 *   - rate limit        : at most RATE_MAX banners per RATE_WINDOW_MS, so a
 *                         bad first sync can't carpet the screen.
 *
 * Backend: terminal-notifier when installed (clickable, grouped), else
 * `osascript -e 'display notification'`. Anywhere but macOS this is a no-op.
 */

export interface EventSpec {
  /** What fires it, shown by `kona notify`. */
  summary: string;
  /** Whether it is on when the config says nothing about it. */
  default: boolean;
}

/**
 * The notifiable events on THIS machine — the platform's own, plus whatever the
 * loaded applets declare in their `notifications` block. It is a registry the
 * loader fills, not a list to append to: an applet says which banners it can
 * raise where it raises them, and `kona notify` lists what is installed.
 *
 * Unregistered events are off, so a banner can never fire from a name nobody
 * declared.
 */
export const EVENTS: Record<string, EventSpec> = {
  "kona.test": { summary: "`kona notify test` — a hand-fired banner", default: true },
};

/**
 * Fold applets' declared events into EVENTS. The daemon calls this at boot and
 * the CLI before it prints the switchboard; both hand over the applets they
 * loaded. Idempotent, and the first declaration of an event wins.
 */
export function registerEvents(applets: Array<{ id: string; notifications?: Record<string, { summary: string; default?: boolean }> }>): void {
  for (const applet of applets) {
    for (const [event, spec] of Object.entries(applet.notifications ?? {})) {
      EVENTS[event] ??= { summary: spec.summary, default: spec.default ?? false };
    }
  }
}

/** Register the events of every applet installed here. */
export async function loadEvents(): Promise<Record<string, EventSpec>> {
  const { loadApplets } = await import("../core/load.ts");
  registerEvents(await loadApplets());
  return EVENTS;
}

export interface NotifyConfig {
  /** Master switch. Absent = on. */
  enabled?: boolean;
  /** Play the notification sound. Absent = on. */
  sound?: boolean;
  /** Per-event opt-in. `"*"` is the fallback for events not listed. */
  events?: Record<string, boolean>;
}

export interface Notification {
  /** An EVENTS key. Decides opt-in, and groups the banner. */
  event: string;
  title: string;
  body: string;
  subtitle?: string;
  /** Opened on click (terminal-notifier only). */
  url?: string;
  /** Dedupe identity. Defaults to the event + text. */
  key?: string;
  /** How long this key stays deduped. Default DEDUPE_MS. */
  dedupeMs?: number;
}

export type NotifyResult = "sent" | "disabled" | "duplicate" | "throttled" | "unsupported" | "failed";

const DEDUPE_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const SOUND_NAME = "Submarine";

export const CONFIG_FILE = (): string =>
  process.env.KONA_NOTIFY_CONFIG ?? join(homedir(), ".config", "kona", "notify.json");

// --- config: read straight off disk, cached briefly so a `kona notify on ...`
// takes effect in the running daemon within a second or two without us hammering
// the filesystem on every 1s tick.
let cached: { path: string; at: number; mtimeMs: number; cfg: NotifyConfig } | null = null;
const CONFIG_TTL_MS = 1_000;

export function readConfig(): NotifyConfig {
  const path = CONFIG_FILE();
  const now = Date.now();
  if (cached && cached.path === path && now - cached.at < CONFIG_TTL_MS) return cached.cfg;
  let cfg: NotifyConfig = {};
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
    cfg = JSON.parse(readFileSync(path, "utf8")) as NotifyConfig;
  } catch {
    cfg = {};
  }
  cached = { path, at: now, mtimeMs, cfg };
  return cfg;
}

/** Persist one event's opt-in state; returns the config as written. */
export function setEvent(event: string, on: boolean): NotifyConfig {
  const path = CONFIG_FILE();
  const cfg = readConfig();
  const next: NotifyConfig = { ...cfg, events: { ...cfg.events, [event]: on } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  cached = null;
  return next;
}

/** Flip the master switch (`kona notify on/off all`). */
export function setEnabled(on: boolean): NotifyConfig {
  const path = CONFIG_FILE();
  const next: NotifyConfig = { ...readConfig(), enabled: on };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  cached = null;
  return next;
}

/**
 * Is this event opted in? KONA_NOTIFY=0/1 overrides everything (tests and
 * `KONA_NOTIFY=0 kona daemon` for a quiet session); otherwise the config file
 * decides, falling back to the event's declared default.
 */
export function isEnabled(event: string): boolean {
  if (process.env.KONA_NOTIFY === "0") return false;
  if (process.env.KONA_NOTIFY === "1") return true;
  // `bun test` drives real ticks — never let a test suite pop banners.
  if (process.env.NODE_ENV === "test") return false;
  const cfg = readConfig();
  if (cfg.enabled === false) return false;
  const per = cfg.events?.[event] ?? cfg.events?.["*"];
  if (typeof per === "boolean") return per;
  return EVENTS[event]?.default ?? false;
}

// --- dedupe + rate limit (daemon-lifetime memory; a restart forgets, which is
// the right amount of memory for "did I already say this?")
const lastSeen = new Map<string, number>();
const recent: number[] = [];

function deduped(key: string, windowMs: number, now: number): boolean {
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < windowMs) return true;
  lastSeen.set(key, now);
  if (lastSeen.size > 500) {
    // Map iterates in insertion order — drop the oldest half.
    for (const k of [...lastSeen.keys()].slice(0, 250)) lastSeen.delete(k);
  }
  return false;
}

function throttled(now: number): boolean {
  while (recent.length && now - recent[0]! > RATE_WINDOW_MS) recent.shift();
  if (recent.length >= RATE_MAX) return true;
  recent.push(now);
  return false;
}

// --- backend
export type Backend = "terminal-notifier" | "osascript";

let detected: Backend | null | undefined;
function backend(): Backend | null {
  if (detected !== undefined) return detected;
  if (process.platform !== "darwin") return (detected = null);
  detected = Bun.which("terminal-notifier") ? "terminal-notifier" : Bun.which("osascript") ? "osascript" : null;
  return detected;
}

/** AppleScript string literal: escape the quotes, flatten the newlines. */
function applescript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s*[\r\n]+\s*/g, " ");
}

/** The argv for one notification. Exported so tests can assert on escaping. */
export function buildCommand(be: Backend, n: Notification, sound = true): string[] {
  if (be === "terminal-notifier") {
    return [
      "terminal-notifier",
      "-title", n.title,
      "-message", n.body,
      ...(n.subtitle ? ["-subtitle", n.subtitle] : []),
      // One group per event: a newer banner replaces the older one in place.
      "-group", `kona.${n.event}`,
      ...(n.url ? ["-open", n.url] : []),
      ...(sound ? ["-sound", SOUND_NAME] : []),
    ];
  }
  const parts = [
    `display notification "${applescript(n.body)}"`,
    `with title "${applescript(n.title)}"`,
    ...(n.subtitle ? [`subtitle "${applescript(n.subtitle)}"`] : []),
    ...(sound ? [`sound name "${SOUND_NAME}"`] : []),
  ];
  return ["osascript", "-e", parts.join(" ")];
}

/** Swappable so tests (and KONA_NOTIFY_DRY) never spawn a real process. */
export type Sender = (cmd: string[], n: Notification) => boolean | Promise<boolean>;
let sender: Sender | null = null;
/** Test seam: install a fake sender, or pass null to restore the real one. */
export function __setSender(s: Sender | null): void {
  sender = s;
}
/** Test seam: forget dedupe/rate-limit/config caches. */
export function __reset(): void {
  lastSeen.clear();
  recent.length = 0;
  cached = null;
  detected = undefined;
}

async function spawnNotifier(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  // osascript is ~50ms; if it wedges (no window server, locked screen) don't
  // hold a tick's promise open forever.
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    return (await proc.exited) === 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post a native notification. Returns why nothing appeared when it doesn't —
 * callers can ignore that; nothing here throws, and nothing here blocks a tick
 * for long. Fire-and-forget from a sync tick with `void notify(...)`.
 */
export async function notify(n: Notification): Promise<NotifyResult> {
  if (!isEnabled(n.event)) return "disabled";

  const now = Date.now();
  const key = n.key ?? `${n.event}:${n.title}:${n.body}`;
  if (deduped(key, n.dedupeMs ?? DEDUPE_MS, now)) return "duplicate";
  if (throttled(now)) return "throttled";

  const be = backend();
  const cmd = be ? buildCommand(be, n, readConfig().sound !== false) : [];

  if (sender) return (await sender(cmd, n)) ? "sent" : "failed";
  if (process.env.KONA_NOTIFY_DRY) {
    console.error(`[notify:${n.event}] ${n.title} — ${n.body}`);
    return "sent";
  }
  if (!be) return "unsupported";

  try {
    return (await spawnNotifier(cmd)) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The "is this new?" bookkeeping every notifying applet needs: remember the ids
 * you have already announced, and treat the FIRST call as adoption — a daemon
 * boot must not banner all twelve open PRs. Returns only the genuinely new ids.
 */
export function freshIds(seen: Set<string> | null, ids: string[]): { seen: Set<string>; fresh: string[] } {
  const next = seen ?? new Set<string>();
  const fresh = seen === null ? [] : ids.filter((id) => !next.has(id));
  for (const id of ids) next.add(id);
  if (next.size > 500) for (const id of [...next].slice(0, 250)) next.delete(id);
  return { seen: next, fresh };
}
