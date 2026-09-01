import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { configDir } from "./config.ts";
import { packageDirs } from "./load.ts";
import type { AnyApplet } from "../sdk/index.ts";

/**
 * `kona plugin install` — an applet package somebody else built.
 *
 * Discovery has always worked: anything under `~/.config/kona/plugins/<name>/`
 * is loaded exactly like a built-in (see core/load.ts). What was missing was
 * the step BEFORE it — getting a package there without a hand-rolled `git
 * clone`. So this stays deliberately thin: it puts a directory in the plugin
 * dir (cloned, copied or symlinked), installs that package's own dependencies,
 * and gets out of the way. There is no manifest format, no lockfile and no
 * update protocol — a plugin is still just a directory with an `index.ts`.
 *
 * The FILESYSTEM is the source of truth. `~/.config/kona/plugins.json` sits
 * beside links.json and only remembers where each install CAME from, so a
 * package you dropped into the plugin dir by hand lists and removes exactly
 * like an installed one, and deleting that file loses provenance, never an
 * applet.
 */

/** How a plugin got here: cloned, copied, or symlinked to a working checkout. */
export type PluginKind = "git" | "copy" | "link";

/** One line of `plugins.json`: where an installed package came from. */
export interface PluginRecord {
  /** Directory name under the plugin dir — what `kona plugin remove` names. */
  name: string;
  kind: PluginKind;
  /** The argument that was installed: a git URL, or an absolute path. */
  source: string;
  /** When, ISO-8601. */
  installed: string;
}

/** An installed plugin, as `kona plugin list` reports it. */
export interface Plugin {
  name: string;
  /** Absolute path in the plugin dir (a symlink, when `kind` is "link"). */
  dir: string;
  kind: PluginKind;
  /** Where it came from, when that is knowable; null for a hand-placed dir. */
  source: string | null;
  /** The applet ids it declares — plural, since one package may hold several. */
  ids: string[];
  /** The package dirs inside it (each holding an `index.ts`). */
  packages: string[];
  /** Why nothing loaded, when nothing did. */
  error: string | null;
}

/** What `bun install` did, if there was anything to install. */
export type DepsResult = "installed" | "skipped" | "none" | "failed";

export interface Installed extends Plugin {
  deps: DepsResult;
}

export interface InstallOpts {
  /** Install under this name instead of the one inferred from the source. */
  as?: string;
  /** Symlink a local path instead of copying it (for developing a plugin). */
  link?: boolean;
  /** Run `bun install` in the package when it has a package.json (default true). */
  deps?: boolean;
}

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

/** `~/.config/kona/plugins` — the dir the loader always scans. */
export const pluginsDir = (): string => join(configDir(), "plugins");

/** `~/.config/kona/plugins.json` — provenance, not truth. */
export const pluginsFile = (): string => join(configDir(), "plugins.json");

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Every record on this machine. Malformed content reads as none: provenance is
 * a nicety, and a corrupt file must not stop `kona plugin list` from telling
 * you what is actually installed.
 */
export function readRecords(): PluginRecord[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(pluginsFile(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is PluginRecord =>
        !!r &&
        typeof r === "object" &&
        typeof (r as PluginRecord).name === "string" &&
        typeof (r as PluginRecord).source === "string" &&
        ["git", "copy", "link"].includes((r as PluginRecord).kind),
    );
  } catch {
    return [];
  }
}

function writeRecords(records: PluginRecord[]): void {
  const file = pluginsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

/**
 * A plugin name is a directory name in the plugin dir, so it is held to the
 * same shape as one: no separators, no leading dot, nothing that could climb
 * out of the dir it is joined to.
 */
export function validPluginName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) && !name.includes("..");
}

/**
 * Does this source name a repository to clone rather than a directory to copy?
 * Every git spelling that isn't a bare path: a URL scheme, scp-style
 * `git@host:owner/repo`, or a `.git` suffix. A path that exists on disk wins
 * over all of it (see installPlugin) — the filesystem is never ambiguous.
 */
export function isGitSource(source: string): boolean {
  return (
    /^(?:https?|ssh|git|git\+ssh|git\+https|file):\/\//.test(source) ||
    /^[\w.+-]+@[^\s/]+:/.test(source) ||
    /\.git\/?$/.test(source)
  );
}

/**
 * The name an install lands under when `--as` doesn't say: the last path
 * segment, minus `.git`. `git@github.com:me/kona-tome.git` and
 * `~/src/kona-tome/` both give `kona-tome`.
 */
export function pluginName(source: string): string {
  const trimmed = source.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"), trimmed.lastIndexOf(":"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** The `origin` remote a clone remembers, read straight out of `.git/config`. */
function gitOrigin(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, ".git", "config"), "utf8");
    return /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The applet ids a set of package dirs declares, and why one didn't load. */
async function idsIn(packages: string[]): Promise<{ ids: string[]; error: string | null }> {
  const ids: string[] = [];
  let error: string | null = null;
  for (const dir of packages) {
    const entry = join(dir, "index.ts");
    try {
      const def = ((await import(entry)) as { default?: AnyApplet }).default;
      if (def?.id) ids.push(def.id);
      else error ??= `${entry} does not default-export defineApplet(...)`;
    } catch (e) {
      error ??= `could not load ${entry}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ids, error };
}

/** One installed plugin, described from what is on disk right now. */
export async function describePlugin(name: string): Promise<Plugin> {
  const dir = join(pluginsDir(), name);
  const link = isLink(dir);
  const record = readRecords().find((r) => r.name === name);
  const kind: PluginKind = link ? "link" : (record?.kind ?? (existsSync(join(dir, ".git")) ? "git" : "copy"));
  const source = link ? readTarget(dir) : (record?.source ?? gitOrigin(dir));
  // A link whose checkout has moved away is the one case where a plugin dir
  // exists and has nothing behind it — say so instead of reporting it empty.
  if (link && !isDir(dir)) {
    return { name, dir, kind, source, ids: [], packages: [], error: `source is gone: ${source ?? "?"}` };
  }
  const packages = await packageDirs(dir);
  if (!packages.length) {
    return { name, dir, kind, source, ids: [], packages, error: "no index.ts — not an applet package" };
  }
  const { ids, error } = await idsIn(packages);
  return { name, dir, kind, source, ids, packages, error };
}

const readTarget = (p: string): string | null => {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
};

/**
 * Every plugin in the plugin dir, by name. This reads the DIRECTORY, not the
 * record file, so a package copied in by hand is listed like any other — and
 * the roots added by `plugins = [...]`/`KONA_PLUGINS` are deliberately absent:
 * those are yours to manage, and `kona plugin remove` will never touch them.
 */
export async function listPlugins(): Promise<Plugin[]> {
  let names: string[];
  try {
    names = readdirSync(pluginsDir()).filter((n) => !n.startsWith("."));
  } catch {
    return []; // no plugin dir yet — nothing installed
  }
  const out: Plugin[] = [];
  for (const name of names.sort()) {
    const dir = join(pluginsDir(), name);
    if (!isLink(dir) && !isDir(dir)) continue; // a stray file is not a plugin
    out.push(await describePlugin(name));
  }
  return out;
}

/** Undo a half-finished install without ever following a link out of the dir. */
function scrub(dir: string): void {
  if (isLink(dir)) unlinkSync(dir);
  else rmSync(dir, { recursive: true, force: true });
}

async function clone(source: string, dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "clone", source, dir], {
    stdout: "pipe",
    stderr: "pipe",
    // Never sit on a credential prompt inside a command someone is waiting on:
    // a private repo you can't reach should fail, and say so, immediately.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    scrub(dir);
    throw new Error(`git clone failed (exit ${code})${err.trim() ? `\n${err.trim()}` : ""}`);
  }
}

/** A package brings its own dependencies; install them where they belong. */
async function installDeps(dir: string): Promise<DepsResult> {
  if (!existsSync(join(dir, "package.json"))) return "none";
  const proc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0 ? "installed" : "failed";
}

/**
 * Install a plugin package into `~/.config/kona/plugins/<name>`.
 *
 * A git URL is cloned; a local path is copied, or symlinked with `--link`
 * (which is what you want while developing a plugin against a checkout you
 * keep editing). Either way the result has to be a package — a dir with an
 * `index.ts`, or a dir full of them — or the install is undone rather than
 * leaving a directory the loader will silently ignore.
 *
 * Failures throw with a message meant to be printed as-is.
 */
export async function installPlugin(source: string, opts: InstallOpts = {}): Promise<Installed> {
  const src = source.trim();
  if (!src) throw new Error("usage: kona plugin install <git-url|path> [--as <name>] [--link]");

  // A path that exists beats every git spelling: `./kona-tome.git` on disk is
  // a directory to copy, not a URL to fetch.
  const local = resolve(expandHome(src));
  const localDir = isDir(local);
  const git = !localDir && isGitSource(src);
  if (!git && !localDir) {
    throw new Error(
      existsSync(local)
        ? `${local} is not a directory — a plugin is a package dir`
        : `no such directory: ${local}\n(and "${src}" is not a git url)`,
    );
  }
  if (opts.link && git) throw new Error("--link needs a local path — a git url has nothing to link to");

  const name = (opts.as ?? pluginName(git ? src : local)).trim();
  if (!validPluginName(name)) {
    throw new Error(`"${name}" is not a usable directory name — install it with --as <name>`);
  }

  const root = pluginsDir();
  const dir = join(root, name);
  if (existsSync(dir) || isLink(dir)) {
    throw new Error(`${dir} already exists — \`kona plugin remove ${name}\`, or install it with --as <other-name>`);
  }
  if (!git && (local === root || local.startsWith(root + sep))) {
    throw new Error(`${local} is already in the plugin dir`);
  }

  const kind: PluginKind = git ? "git" : opts.link ? "link" : "copy";
  mkdirSync(root, { recursive: true });
  if (git) await clone(src, dir);
  else if (opts.link) symlinkSync(local, dir, "dir");
  else {
    // A copy takes the SOURCE, not its build output: `node_modules` is
    // restored by `bun install` below, and `.git` would make a copy look like
    // a clone (and quietly bloat the plugin dir).
    cpSync(local, dir, {
      recursive: true,
      dereference: false,
      filter: (from) => basename(from) !== "node_modules" && basename(from) !== ".git",
    });
  }

  const packages = await packageDirs(dir);
  if (!packages.length) {
    scrub(dir);
    throw new Error(
      `no applet package in ${git ? src : local} — expected an index.ts, or a directory of packages that each have one`,
    );
  }

  // A symlinked plugin points at a checkout that is somebody's working copy;
  // running `bun install` inside it would be reaching into their tree.
  const deps = opts.deps === false || kind === "link" ? "skipped" : await installDeps(dir);

  writeRecords([
    ...readRecords().filter((r) => r.name !== name),
    { name, kind, source: git ? src : local, installed: new Date().toISOString() },
  ]);

  const { ids, error } = await idsIn(packages);
  return { name, dir, kind, source: git ? src : local, ids, packages, error, deps };
}

/**
 * Delete an installed plugin. A symlinked one loses the LINK, never the
 * checkout behind it — `--link` must be safe to undo.
 */
export async function removePlugin(name: string): Promise<Plugin> {
  if (!validPluginName(name)) throw new Error(`not a plugin name: ${name}`);
  const dir = join(pluginsDir(), name);
  if (!existsSync(dir) && !isLink(dir)) throw new Error(`not installed: ${name} (${dir})`);
  const plugin = await describePlugin(name);
  scrub(dir);
  writeRecords(readRecords().filter((r) => r.name !== name));
  return plugin;
}
