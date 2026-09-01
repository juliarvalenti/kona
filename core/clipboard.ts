/**
 * The system clipboard — the one host-side side effect "copy prompt" needs.
 *
 * There is no portable clipboard API, so this is a spawn: the text goes down
 * the helper's stdin (never an argv, which would leak into `ps` and hit ARG_MAX
 * on a long prompt). macOS has `pbcopy` in the base system; a Linux box has
 * whichever of `wl-copy`/`xclip`/`xsel` its session ships, so we probe. Set
 * `KONA_CLIPBOARD` to a command to override — including over SSH, where the
 * clipboard you mean may be on the other end of a pipe.
 */

/** Why nothing reached the clipboard, when it didn't. */
export type CopyResult = "copied" | "unsupported" | "failed";

/** Linux/BSD candidates, in the order a session is most likely to have them. */
const UNIX_HELPERS: string[][] = [
  ["wl-copy"],
  ["xclip", "-selection", "clipboard"],
  ["xsel", "--clipboard", "--input"],
];

/**
 * The argv that reads the clipboard's new contents from stdin, or null when
 * this machine has no helper. Pure enough to test: the platform is a parameter
 * and `have` (which binaries exist) is injectable.
 */
export function clipboardCommand(
  platform: string = process.platform,
  have: (bin: string) => boolean = (bin) => !!Bun.which(bin),
): string[] | null {
  const override = process.env.KONA_CLIPBOARD?.trim();
  if (override) return override.split(/\s+/);
  if (platform === "darwin") return ["pbcopy"]; // base system, always there
  if (platform === "win32") return ["clip"];
  return UNIX_HELPERS.find((cmd) => have(cmd[0]!)) ?? null;
}

/** What a helper is called, for a message to the human ("no clipboard helper"). */
export const clipboardHelpers = (): string => UNIX_HELPERS.map((c) => c[0]).join(", ");

/**
 * Put `text` on the clipboard. Never throws — a missing helper or a wedged one
 * is a footer note, not a crash in the middle of someone's TUI.
 */
export async function copyToClipboard(text: string): Promise<CopyResult> {
  const cmd = clipboardCommand();
  if (!cmd) return "unsupported";
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    await proc.stdin.end();
    // A helper that wedges (no display, a dead X server) must not hang the host.
    const timer = setTimeout(() => proc.kill(), 5_000);
    try {
      return (await proc.exited) === 0 ? "copied" : "failed";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "failed";
  }
}
