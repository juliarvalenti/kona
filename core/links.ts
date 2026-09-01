import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configDir } from "./config.ts";

/**
 * Linked applets — an applet file you ran directly.
 *
 * `kona <path>` (and therefore `#!/usr/bin/env kona` at the top of a `chmod +x`
 * applet) opens a file that lives nowhere kona scans. That has to survive the
 * command: an applet an agent can only reach while its TUI is open would be a
 * different, lesser thing. So running one REMEMBERS it, as a line in
 * `~/.config/kona/links.json`, and the loader treats those lines as a fourth
 * source alongside `applets/`, `~/.config/kona/plugins/` and `KONA_PLUGINS`.
 *
 * That is the whole persistence story: one flat file of `{ id, entry }` pairs,
 * written by `kona link` and `kona <path>`, dropped by `kona unlink`. An entry
 * whose file has since been deleted is ignored (and pruned on the next write),
 * so a linked applet cannot outlive the file it came from.
 */

export interface Link {
  /** The applet id its module declares — what `kona call <id>` names. */
  id: string;
  /** Absolute path of the module. */
  entry: string;
}

export const linksFile = (): string => join(configDir(), "links.json");

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

/** Absolute, `~` expanded — the one form a link is ever stored in. */
export const linkPath = (p: string): string => resolve(expandHome(p));

/**
 * Every link on this machine, newest last. Malformed content is treated as no
 * links rather than an error: a corrupt file must not stop kona from booting
 * with everything else installed.
 */
export function readLinks(): Link[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(linksFile(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (l): l is Link =>
        !!l && typeof l === "object" && typeof (l as Link).id === "string" && typeof (l as Link).entry === "string",
    );
  } catch {
    return [];
  }
}

function writeLinks(links: Link[]): void {
  const file = linksFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The entries the loader should scan, in file order: links whose module still
 * exists. `KONA_NO_PLUGINS=1` drops them all — a link is an applet from outside
 * this checkout, and the test suite sets that flag so a developer's own links
 * can't change what the suite sees.
 */
export function linkedEntries(): string[] {
  if (process.env.KONA_NO_PLUGINS === "1") return [];
  return readLinks()
    .map((l) => l.entry)
    .filter((entry) => existsSync(entry));
}

/**
 * Remember `entry` as applet `id`. Keyed by path, so running the same file
 * twice links it once and a file that has been rewritten to declare a new id
 * updates in place rather than accumulating a stale row.
 */
export function linkApplet(id: string, entry: string): Link {
  const link: Link = { id, entry: linkPath(entry) };
  const kept = readLinks().filter((l) => l.entry !== link.entry && existsSync(l.entry));
  writeLinks([...kept, link]);
  return link;
}

/** Forget a link, by applet id or by path. Returns the link that was dropped. */
export function unlinkApplet(idOrPath: string): Link | null {
  const links = readLinks();
  const path = linkPath(idOrPath);
  const gone = links.find((l) => l.id === idOrPath || l.entry === path);
  if (!gone) return null;
  writeLinks(links.filter((l) => l !== gone));
  return gone;
}
