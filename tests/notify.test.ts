import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  notify,
  buildCommand,
  freshIds,
  isEnabled,
  setEvent,
  setEnabled,
  readConfig,
  registerEvents,
  __setSender,
  __reset,
  type Notification,
} from "../server/notify.ts";
import timer from "../applets/timer/index.ts";
import type { AppletCtx } from "../sdk/index.ts";

/**
 * Notifications are the one place kona reaches outside the process, so the
 * tests pin the parts that decide WHETHER a banner happens (opt-in, dedupe,
 * rate limit) and WHAT gets handed to the OS — never spawning anything: the
 * sender is faked, and the config lives in a throwaway dir.
 */

// The event catalogue is built from the applets that are loaded — the daemon
// does this at boot, so a test that fires `timer.done` does it too.
registerEvents([timer]);

let sent: Notification[] = [];
let configFile: string;
let savedNodeEnv: string | undefined;

beforeAll(() => {
  configFile = join(mkdtempSync(join(tmpdir(), "kona-notify-")), "notify.json");
  process.env.KONA_NOTIFY_CONFIG = configFile;
  // The library disables itself under NODE_ENV=test so a suite that drives a
  // real tick can't pop banners. These tests are testing that machinery, so
  // they opt back in — with a fake sender, nothing escapes.
  savedNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  __setSender((_cmd, n) => {
    sent.push(n);
    return true;
  });
});

afterAll(() => {
  __setSender(null);
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  delete process.env.KONA_NOTIFY;
});

beforeEach(() => {
  sent = [];
  delete process.env.KONA_NOTIFY;
  writeFileSync(configFile, "{}");
  __reset();
});

const ping = (over: Partial<Notification> = {}) =>
  notify({ event: "timer.done", title: "Timer done", body: "05:00 is up.", ...over });

test("events are opt-in: declared defaults decide when config is silent", async () => {
  expect(await ping()).toBe("sent"); // timer.done defaults on
  expect(await ping({ event: "email.unread", key: "a" })).toBe("disabled"); // defaults off
  expect(await ping({ event: "made.up", key: "b" })).toBe("disabled"); // unknown = off
  expect(sent).toHaveLength(1);
});

test("the config file turns individual events on and off", async () => {
  setEvent("email.unread", true);
  setEvent("timer.done", false);
  __reset();
  expect(isEnabled("email.unread")).toBe(true);
  expect(isEnabled("timer.done")).toBe(false);
  expect(await ping()).toBe("disabled");
  expect(await ping({ event: "email.unread", key: "x" })).toBe("sent");
  // written where `kona notify` will find it, and readable back
  expect(JSON.parse(readFileSync(configFile, "utf8")).events["email.unread"]).toBe(true);
  expect(readConfig().events?.["timer.done"]).toBe(false);
});

test("the master switch and KONA_NOTIFY override everything", async () => {
  setEnabled(false);
  __reset();
  expect(await ping()).toBe("disabled");

  process.env.KONA_NOTIFY = "1"; // force on, even for a default-off event
  expect(isEnabled("email.unread")).toBe(true);
  expect(await ping({ event: "email.unread", key: "forced" })).toBe("sent");

  // kill switch wins even over a config that enables everything
  setEnabled(true);
  setEvent("timer.done", true);
  __reset();
  process.env.KONA_NOTIFY = "0";
  expect(await ping({ key: "quiet" })).toBe("disabled");
});

test("a repeat inside the dedupe window is dropped; a new key is not", async () => {
  expect(await ping({ key: "same" })).toBe("sent");
  expect(await ping({ key: "same" })).toBe("duplicate");
  expect(await ping({ key: "other" })).toBe("sent");
  expect(sent).toHaveLength(2);
});

test("dedupe defaults to the notification's own text", async () => {
  expect(await ping()).toBe("sent");
  expect(await ping()).toBe("duplicate");
  expect(await ping({ body: "10:00 is up." })).toBe("sent");
});

test("a burst is rate limited instead of carpeting the screen", async () => {
  const results = [];
  for (let i = 0; i < 8; i++) results.push(await ping({ key: `burst-${i}` }));
  expect(results.filter((r) => r === "sent")).toHaveLength(5);
  expect(results.filter((r) => r === "throttled")).toHaveLength(3);
});

test("osascript command escapes quotes and flattens newlines", () => {
  const cmd = buildCommand("osascript", {
    event: "timer.done",
    title: 'say "hi"',
    body: "line one\nline two",
    subtitle: "back\\slash",
  });
  expect(cmd[0]).toBe("osascript");
  expect(cmd[1]).toBe("-e");
  const script = cmd[2]!;
  expect(script).toContain('display notification "line one line two"');
  expect(script).toContain('with title "say \\"hi\\""');
  expect(script).toContain('subtitle "back\\\\slash"');
  expect(script).toContain('sound name "Submarine"');
  expect(script).not.toContain("\n");
  // sound off is honored
  expect(buildCommand("osascript", { event: "e", title: "t", body: "b" }, false)[2]).not.toContain("sound");
});

test("terminal-notifier command carries the click URL and an event group", () => {
  const cmd = buildCommand("terminal-notifier", {
    event: "github.new",
    title: "PR · o/r",
    body: "add notifications",
    url: "https://example.test/pr/1",
  });
  expect(cmd).toContain("-open");
  expect(cmd).toContain("https://example.test/pr/1");
  expect(cmd[cmd.indexOf("-group") + 1]).toBe("kona.github.new");
  expect(cmd[cmd.indexOf("-message") + 1]).toBe("add notifications");
});

test("freshIds adopts the first batch silently, then reports only new ids", () => {
  const boot = freshIds(null, ["a", "b"]);
  expect(boot.fresh).toEqual([]); // a daemon restart is not twelve new PRs

  const next = freshIds(boot.seen, ["a", "b", "c"]);
  expect(next.fresh).toEqual(["c"]);

  // an id that drops off the list and comes back is still not new
  const again = freshIds(next.seen, ["c", "a"]);
  expect(again.fresh).toEqual([]);
});

test("every pomodoro phase boundary banners its own event", () => {
  const state = structuredClone(timer.initialState);
  const ctx: AppletCtx<typeof state> = { state, emit: () => {} };
  timer.verbs["pomodoro.start"]!({ work: "2s", short: "1s", every: 2 }, ctx);

  timer.tick!(ctx);
  expect(sent).toHaveLength(0); // mid-phase: nothing to say

  timer.tick!(ctx); // work -> break
  expect(sent).toHaveLength(1);
  expect(sent[0]!.event).toBe("timer.pomodoro"); // its own key: toggleable on its own
  expect(sent[0]!.title).toBe("Time for a break");
  expect(sent[0]!.body).toContain("1 done today");

  timer.tick!(ctx); // break -> work, a distinct key so it doesn't dedupe away
  expect(sent).toHaveLength(2);
  expect(sent[1]!.title).toBe("Break's over, back to it");
  expect(sent[1]!.body).toContain("round 2/2");
});

test("skipping a phase by hand stays quiet — you are already here", () => {
  const state = structuredClone(timer.initialState);
  const ctx: AppletCtx<typeof state> = { state, emit: () => {} };
  timer.verbs["pomodoro.start"]!({ work: "2s" }, ctx);
  timer.verbs["pomodoro.skip"]!({}, ctx);
  expect(sent).toHaveLength(0);
});

test("a countdown reaching zero notifies once, with its label", async () => {
  const state = structuredClone(timer.initialState);
  const ctx: AppletCtx<typeof state> = { state, emit: () => {} };
  timer.verbs.start!({ seconds: 2, label: "tea" }, ctx);

  timer.tick!(ctx);
  expect(sent).toHaveLength(0); // still counting

  timer.tick!(ctx);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.event).toBe("timer.done");
  expect(sent[0]!.title).toContain("tea");
  expect(sent[0]!.body).toContain("00:02");

  timer.tick!(ctx); // past zero: no second banner
  expect(sent).toHaveLength(1);
});

test("an event that plays its own cue banners silently — one sound, not two", async () => {
  // The timer makes a noise of its own now (server/sound.ts). A banner that
  // added its generic ding on top would be two sounds for one finished timer,
  // so the applet tells notify() to keep quiet — but only when a cue really
  // played, which is why the no-player case still gets the banner's sound.
  const { __setPlayer } = await import("../server/sound.ts");
  const { resetConfig } = await import("../core/config.ts");
  const prevDir = process.env.KONA_CONFIG_DIR;
  process.env.KONA_CONFIG_DIR = mkdtempSync(join(tmpdir(), "kona-notify-cfg-"));
  resetConfig();
  try {
    // A distinct label per run keeps the two banners out of each other's
    // dedupe window.
    const run = (label: string) => {
      const state = structuredClone(timer.initialState);
      const ctx: AppletCtx<typeof state> = { state, emit: () => {} };
      timer.verbs.start!({ seconds: 1, label }, ctx);
      timer.tick!(ctx);
    };

    __setPlayer(() => true);
    run("tea");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.silent).toBe(true);
    expect(buildCommand("osascript", sent[0]!, !sent[0]!.silent)[2]).not.toContain("sound");

    // Nothing can play here, whatever this machine has installed: the banner
    // keeps its own sound rather than leaving a finished timer inaudible.
    __setPlayer(null);
    process.env.KONA_SOUND = "0";
    sent = [];
    run("pasta");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.silent).toBe(false);
  } finally {
    __setPlayer(null);
    delete process.env.KONA_SOUND;
    if (prevDir === undefined) delete process.env.KONA_CONFIG_DIR;
    else process.env.KONA_CONFIG_DIR = prevDir;
    resetConfig();
  }
});
