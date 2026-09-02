import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TONES,
  resolveSound,
  playerCommand,
  soundCommand,
  canPlay,
  soundEnabled,
  playSound,
  warmupOption,
  warmupLead,
  __setPlayer,
} from "../server/sound.ts";
import { DEFAULT_WARMUP_MS, MAX_WARMUP_MS, resetConfig } from "../core/config.ts";

/**
 * Sound is the second way kona reaches outside the process, so these tests pin
 * the same two questions the notification tests do: WHETHER anything plays
 * (env, a file that is really there, a player that exists) and WHAT gets handed
 * to the OS. Nothing here spawns: the platform, the filesystem and `which` are
 * all parameters, and the one end-to-end test installs a fake player.
 */

const has = (...paths: string[]) => (p: string) => paths.includes(p);
const have = (...bins: string[]) => (b: string) => bins.includes(b);

const dirs: string[] = [];
const prevCfgDir = process.env.KONA_CONFIG_DIR;

/** A throwaway config dir holding this TOML — the machine's own file must not
 *  decide whether a warm-up test warms up. */
function withConfig(toml?: string): void {
  const dir = mkdtempSync(join(tmpdir(), "kona-sound-"));
  dirs.push(dir);
  if (toml !== undefined) writeFileSync(join(dir, "config.toml"), toml);
  process.env.KONA_CONFIG_DIR = dir;
  resetConfig();
}

beforeEach(() => {
  __setPlayer(null);
  delete process.env.KONA_SOUND;
  delete process.env.KONA_SOUND_PLAYER;
  withConfig();
});

afterAll(() => {
  __setPlayer(null);
  delete process.env.KONA_SOUND;
  delete process.env.KONA_SOUND_PLAYER;
  if (prevCfgDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevCfgDir;
  resetConfig();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a tone resolves to this OS's own sound file", () => {
  expect(resolveSound("alarm", "darwin", has("/System/Library/Sounds/Sosumi.aiff"))).toBe(
    "/System/Library/Sounds/Sosumi.aiff",
  );
  expect(
    resolveSound("alarm", "linux", has("/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga")),
  ).toBe("/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga");
});

test("every tone in the vocabulary names a file on both platforms", () => {
  // The point of a tone name is that a config written on a Mac still makes a
  // sound on Linux — so neither half of a tone may be left blank.
  for (const [name, tone] of Object.entries(TONES)) {
    expect(tone.darwin, name).not.toBe("");
    expect(tone.xdg, name).not.toBe("");
    expect(resolveSound(name, "darwin", has(`/System/Library/Sounds/${tone.darwin}.aiff`))).not.toBeNull();
    expect(
      resolveSound(name, "linux", has(`/usr/share/sounds/freedesktop/stereo/${tone.xdg}.oga`)),
    ).not.toBeNull();
  }
});

test("an unknown bare name is still tried as an OS sound name", () => {
  // `done = "Frog"` should work on a Mac without kona having heard of Frog.
  expect(resolveSound("Frog", "darwin", has("/System/Library/Sounds/Frog.aiff"))).toBe(
    "/System/Library/Sounds/Frog.aiff",
  );
  expect(resolveSound("Frog", "darwin", has())).toBeNull();
});

test("a path is taken as a path, tilde and all", () => {
  const home = process.env.HOME ?? "";
  expect(resolveSound("~/snd/gong.wav", "linux", has(`${home}/snd/gong.wav`))).toBe(`${home}/snd/gong.wav`);
  expect(resolveSound("/opt/gong.wav", "linux", has("/opt/gong.wav"))).toBe("/opt/gong.wav");
  // A path that is not there is not silently swapped for a tone.
  expect(resolveSound("/opt/gong.wav", "linux", has())).toBeNull();
  expect(resolveSound("", "linux", has())).toBeNull();
});

test("the player is probed in order, and spells volume its own way", () => {
  expect(playerCommand("/s.aiff", 1, have("afplay"))).toEqual(["afplay", "-v", "1.00", "/s.aiff"]);
  expect(playerCommand("/s.oga", 0.5, have("paplay"))).toEqual(["paplay", "--volume=32768", "/s.oga"]);
  expect(playerCommand("/s.oga", 0.5, have("mpv"))).toEqual([
    "mpv",
    "--really-quiet",
    "--no-video",
    "--volume=50",
    "/s.oga",
  ]);
  // paplay beats mpv when a box has both — the probe order is the preference.
  expect(playerCommand("/s.oga", 1, have("mpv", "paplay"))![0]).toBe("paplay");
  expect(playerCommand("/s.oga", 1, have())).toBeNull();
});

test("volume is clamped, never handed to a player raw", () => {
  expect(playerCommand("/s.oga", 9, have("ffplay"))).toContain("100");
  expect(playerCommand("/s.oga", -1, have("paplay"))).toContain("--volume=0");
  expect(playerCommand("/s.oga", NaN, have("afplay"))).toContain("1.00");
});

test("KONA_SOUND_PLAYER overrides the probe, with the file appended", () => {
  process.env.KONA_SOUND_PLAYER = "mpg123 -q";
  expect(playerCommand("/s.mp3", 1, have("afplay"))).toEqual(["mpg123", "-q", "/s.mp3"]);
});

test("KONA_SOUND=0 silences the process; =1 opts a test run back in", () => {
  process.env.KONA_SOUND = "0";
  expect(soundEnabled()).toBe(false);
  expect(canPlay("alarm")).toBe(false);
  process.env.KONA_SOUND = "1";
  expect(soundEnabled()).toBe(true);
});

test("a test run is silent unless it says otherwise", () => {
  // NODE_ENV=test under `bun test`, and no fake player installed.
  expect(soundEnabled()).toBe(false);
  expect(process.env.NODE_ENV).toBe("test");
});

test("a fake player makes the machine's audio setup stop mattering", async () => {
  const played: Array<{ sound: string; cmd: string[] | null }> = [];
  __setPlayer((cmd, sound) => {
    played.push({ sound, cmd });
    return true;
  });
  expect(soundEnabled()).toBe(true);
  expect(canPlay("alarm")).toBe(true);
  expect(canPlay("")).toBe(false);
  expect(await playSound("alarm", 0.4)).toBe("played");
  expect(played).toHaveLength(1);
  expect(played[0]!.sound).toBe("alarm");
});

test("nothing is heard, and nothing throws, when the machine can't play it", async () => {
  process.env.KONA_SOUND = "1";
  // A name no OS has: resolution fails before we ever look for a player.
  expect(soundCommand("definitely-not-a-sound-name")).toBeNull();
  expect(await playSound("definitely-not-a-sound-name")).toBe("unknown");
  expect(canPlay("definitely-not-a-sound-name")).toBe(false);
});

/**
 * The warm-up primer — the wireless-headset half of this module.
 *
 * A Bluetooth link idles when nothing is playing and eats the front of the next
 * sound, which makes a short tone inaudible rather than quiet. So the contract
 * is: one near-silent play to wake the device, a beat, then the real one — and
 * NOTHING extra for the wired majority, who never asked for the latency.
 */

/** A player that records every play, in order. */
function recorder() {
  const plays: Array<{ sound: string; volume: number }> = [];
  __setPlayer((_cmd, sound, volume) => {
    plays.push({ sound, volume });
    return true;
  });
  return plays;
}

test("no warm-up by default — a wired listener pays nothing", async () => {
  const plays = recorder();
  expect(await playSound("alarm", 0.5)).toBe("played");
  expect(plays).toEqual([{ sound: "alarm", volume: 0.5 }]);
});

test("a warm-up plays a near-silent primer first, then the real cue", async () => {
  const plays = recorder();
  const started = Date.now();
  expect(await playSound("bell", 0.8, { warmup: 40 })).toBe("played");
  // Two plays, same sound: the primer is the cue itself at a whisper, so it
  // works for any tone or file somebody points at.
  expect(plays.map((p) => p.sound)).toEqual(["bell", "bell"]);
  expect(plays[0]!.volume).toBeLessThan(0.05);
  expect(plays[1]!.volume).toBe(0.8);
  // The lead is really waited: the cue lands AFTER the device has woken.
  expect(Date.now() - started).toBeGreaterThanOrEqual(35);
});

test("`[sound] warmup` turns it on for every cue, with no caller changes", async () => {
  withConfig(`[sound]\nwarmup = "30ms"\n`);
  const plays = recorder();
  await playSound("alarm");
  expect(plays).toHaveLength(2);
  // ...and an explicit `false` still wins, for the one call that must be prompt.
  plays.length = 0;
  await playSound("alarm", 1, { warmup: false });
  expect(plays).toHaveLength(1);
});

test("the lead is capped, and `true` takes the documented one", () => {
  // An hour of lead is somebody's typo, not a request to swallow the cue.
  expect(warmupLead({ warmup: 3_600_000 })).toBe(MAX_WARMUP_MS);
  expect(warmupLead({ warmup: true })).toBe(DEFAULT_WARMUP_MS);
  expect(warmupLead({ warmup: false })).toBe(0);
  expect(warmupLead({ warmup: -5 })).toBe(0);
  expect(warmupLead()).toBe(0); // no config file — off
  withConfig(`[sound]\nwarmup = "700ms"\n`);
  expect(warmupLead()).toBe(700);
  expect(warmupLead({ warmup: false })).toBe(0);
});

test("a primer that fails is still just a cue with no head start", async () => {
  const plays: number[] = [];
  __setPlayer((_cmd, _sound, volume) => {
    plays.push(volume);
    if (volume < 0.05) throw new Error("no device");
    return true;
  });
  expect(await playSound("alarm", 1, { warmup: 10 })).toBe("played");
  expect(plays).toHaveLength(2);
});

test("an unplayable sound never spawns a primer either", async () => {
  process.env.KONA_SOUND = "1";
  expect(await playSound("definitely-not-a-sound-name", 1, { warmup: 10 })).toBe("unknown");
});

test("an applet's own warmup key reads like the global one", () => {
  expect(warmupOption(undefined)).toBeUndefined();
  expect(warmupOption("700ms")).toBe(700);
  expect(warmupOption("off")).toBe(false);
  expect(warmupOption(false)).toBe(false);
  expect(warmupOption(0)).toBe(false);
  // Unreadable is "not set here", NOT "off": the global setting still applies,
  // so a typo in one applet's block can't silently un-fix a headset.
  expect(warmupOption("soonish")).toBeUndefined();
  expect(warmupOption(700)).toBeUndefined(); // 700 SECONDS — past the cap
});
