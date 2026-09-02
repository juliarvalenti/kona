import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  TONES,
  resolveSound,
  playerCommand,
  soundCommand,
  canPlay,
  soundEnabled,
  playSound,
  __setPlayer,
} from "../server/sound.ts";

/**
 * Sound is the second way kona reaches outside the process, so these tests pin
 * the same two questions the notification tests do: WHETHER anything plays
 * (env, a file that is really there, a player that exists) and WHAT gets handed
 * to the OS. Nothing here spawns: the platform, the filesystem and `which` are
 * all parameters, and the one end-to-end test installs a fake player.
 */

const has = (...paths: string[]) => (p: string) => paths.includes(p);
const have = (...bins: string[]) => (b: string) => bins.includes(b);

beforeEach(() => {
  __setPlayer(null);
  delete process.env.KONA_SOUND;
  delete process.env.KONA_SOUND_PLAYER;
});

afterAll(() => {
  __setPlayer(null);
  delete process.env.KONA_SOUND;
  delete process.env.KONA_SOUND_PLAYER;
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
