import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Sound effects — the other half of "you can walk away from a countdown".
 *
 * A banner you have to be looking at is not much use to someone who left the
 * desk, and `server/notify.ts` only reaches macOS anyway. This is the audible
 * channel: an applet asks for a TONE by name and the OS plays a file. It is a
 * spawn, like `core/clipboard.ts`, because there is no portable audio API and a
 * bundled decoder would be a lot of dependency for one ding.
 *
 * Two lookups, both injectable so they are testable off the machine they
 * describe:
 *   - the FILE  : a tone name -> a sound this OS actually ships (macOS system
 *                 sounds, the freedesktop theme elsewhere). Any path works too,
 *                 so `done = "~/snd/gong.wav"` needs no code here.
 *   - the PLAYER: `afplay` on macOS; whichever of paplay/pw-play/ffplay/mpv/play
 *                 a Linux session has. `KONA_SOUND_PLAYER` overrides both.
 *
 * Nothing here throws and nothing blocks a tick: fire it as `void playSound(…)`.
 * `KONA_SOUND=0` silences the process (and `bun test` is silent by default —
 * the suite drives real ticks, and a test run must not make noise).
 */

export interface Tone {
  /** What it is for, as `kona sound` lists it. */
  summary: string;
  /** macOS system sound name — `/System/Library/Sounds/<name>.aiff`. */
  darwin: string;
  /** freedesktop sound-theme name — `…/sounds/freedesktop/stereo/<name>.oga`. */
  xdg: string;
}

/**
 * The vocabulary. Deliberately small and named for the JOB, not the file: an
 * applet asks for "alarm" and each OS supplies its own idea of one, so a config
 * written on a Mac still makes a sound on Linux.
 */
export const TONES: Record<string, Tone> = {
  chime: { summary: "a clean single note", darwin: "Glass", xdg: "complete" },
  bell: { summary: "a short ping", darwin: "Ping", xdg: "bell" },
  alarm: { summary: "an insistent alert", darwin: "Sosumi", xdg: "alarm-clock-elapsed" },
  soft: { summary: "a quiet nudge", darwin: "Purr", xdg: "message" },
  rise: { summary: "a starting flourish", darwin: "Hero", xdg: "service-login" },
  fall: { summary: "a finishing flourish", darwin: "Submarine", xdg: "service-logout" },
};

/** Why nothing was heard, when nothing was. */
export type PlayResult = "played" | "off" | "unknown" | "unsupported" | "failed";

/** Where macOS keeps sounds, most specific first. */
const DARWIN_DIRS = ["~/Library/Sounds", "/Library/Sounds", "/System/Library/Sounds"];
const DARWIN_EXTS = [".aiff", ".aif", ".wav", ".m4a", ".mp3"];

/** The XDG sound theme, and the extensions its packages use. */
const XDG_DIRS = [
  "~/.local/share/sounds/freedesktop/stereo",
  "/usr/local/share/sounds/freedesktop/stereo",
  "/usr/share/sounds/freedesktop/stereo",
  "/usr/share/sounds",
];
const XDG_EXTS = [".oga", ".ogg", ".wav"];

function expand(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * A tone name (or a bare OS sound name, or a path) -> a file that is really
 * there, or null. A name that is not in TONES is still tried verbatim, so
 * `"Frog"` on macOS and `"phone-incoming-call"` on Linux work without kona
 * knowing about them.
 */
export function resolveSound(
  sound: string,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const s = sound.trim();
  if (!s) return null;
  // A path is a path — the caller pointed at a file, so don't go looking.
  if (s.includes("/")) {
    const p = expand(s);
    return exists(p) ? p : null;
  }
  const tone = TONES[s.toLowerCase()];
  const darwin = platform === "darwin";
  // Try this OS's name for the tone first, then the other one: a Linux box with
  // a Mac's sound files copied in still finds them.
  const names = tone ? (darwin ? [tone.darwin, tone.xdg] : [tone.xdg, tone.darwin]) : [s];
  const dirs = darwin ? [...DARWIN_DIRS, ...XDG_DIRS] : [...XDG_DIRS, ...DARWIN_DIRS];
  const exts = darwin ? [...DARWIN_EXTS, ...XDG_EXTS] : [...XDG_EXTS, ...DARWIN_EXTS];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(expand(dir), name + ext);
        if (exists(p)) return p;
      }
    }
  }
  return null;
}

/**
 * The players we know how to drive, in the order a session is likeliest to have
 * one. Each takes a file and a volume in 0..1 — every one of them spells that
 * differently, which is exactly the sort of thing an applet should not have to
 * know.
 */
const PLAYERS: Array<{ bin: string; args: (file: string, volume: number) => string[] }> = [
  { bin: "afplay", args: (f, v) => ["-v", v.toFixed(2), f] },
  { bin: "paplay", args: (f, v) => [`--volume=${Math.round(v * 65536)}`, f] },
  { bin: "pw-play", args: (f, v) => [`--volume=${v.toFixed(2)}`, f] },
  { bin: "ffplay", args: (f, v) => ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(Math.round(v * 100)), f] },
  { bin: "mpv", args: (f, v) => ["--really-quiet", "--no-video", `--volume=${Math.round(v * 100)}`, f] },
  { bin: "play", args: (f, v) => ["-q", f, "vol", v.toFixed(2)] },
];

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * The argv that plays `file`, or null when this machine has nothing to play it
 * with. `KONA_SOUND_PLAYER="mpg123 -q"` wins over the probe — over SSH, or on a
 * box whose player nobody here has heard of.
 */
export function playerCommand(
  file: string,
  volume = 1,
  have: (bin: string) => boolean = (bin) => !!Bun.which(bin),
): string[] | null {
  const override = process.env.KONA_SOUND_PLAYER?.trim();
  if (override) return [...override.split(/\s+/), file];
  const player = PLAYERS.find((p) => have(p.bin));
  return player ? [player.bin, ...player.args(file, clampVolume(volume))] : null;
}

/** File lookup and player probe in one: the whole argv, or null. */
export function soundCommand(sound: string, volume = 1): string[] | null {
  const file = resolveSound(sound);
  return file ? playerCommand(file, volume) : null;
}

/**
 * Is this process allowed to make noise at all? `KONA_SOUND=0`/`1` overrides
 * everything, and `bun test` is silent unless a test says otherwise — the
 * applet suites drive real ticks, and a countdown reaching zero in a test must
 * not ding the developer's speakers.
 */
export function soundEnabled(): boolean {
  if (playerSeam) return true; // a fake player: nothing reaches the speakers anyway
  if (process.env.KONA_SOUND === "0") return false;
  if (process.env.KONA_SOUND === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/**
 * Would asking for this sound actually be heard right now? Callers use it to
 * decide something *else* — the timer keeps its desktop banner silent when the
 * cue is covering it, so a finished countdown makes one sound, not two.
 */
export function canPlay(sound: string): boolean {
  if (!soundEnabled()) return false;
  if (playerSeam) return sound.trim() !== "";
  return soundCommand(sound) !== null;
}

/** Swappable so tests (and `KONA_SOUND_DRY`) never spawn a real process. */
export type Player = (cmd: string[] | null, sound: string, volume: number) => boolean | Promise<boolean>;
let playerSeam: Player | null = null;
/** Test seam: install a fake player, or pass null to restore the real one. */
export function __setPlayer(p: Player | null): void {
  playerSeam = p;
}

async function spawnPlayer(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  // A cue is a second or two; if a player wedges (no audio device, a dead pulse
  // socket) don't leave a process behind for the life of the daemon.
  const timer = setTimeout(() => proc.kill(), 15_000);
  try {
    return (await proc.exited) === 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Play a tone name, an OS sound name or a path. Never throws — a missing file
 * or a machine with no player is a quiet timer, not a crashed daemon.
 */
export async function playSound(sound: string, volume = 1): Promise<PlayResult> {
  if (!soundEnabled()) return "off";
  const file = playerSeam ? sound : resolveSound(sound);
  if (!file) return "unknown";
  const cmd = playerSeam ? soundCommand(sound, volume) : playerCommand(file, volume);
  if (playerSeam) return (await playerSeam(cmd, sound, clampVolume(volume))) ? "played" : "failed";
  if (!cmd) return "unsupported";
  if (process.env.KONA_SOUND_DRY) {
    console.error(`[sound] ${cmd.join(" ")}`);
    return "played";
  }
  try {
    return (await spawnPlayer(cmd)) ? "played" : "failed";
  } catch {
    return "failed";
  }
}
