import { convert as htmlToTextLib } from "html-to-text";

/**
 * Provider-agnostic mail text: address display names and turning the HTML most
 * real mail is made of into something readable in a terminal. Gmail and Outlook
 * both land here, so a receipt reads the same whichever mailbox it came from.
 * Everything is pure (bar the optional renderer subprocess) and unit-tested.
 */

/** "Ada Lovelace <ada@x.com>" -> "Ada Lovelace"; bare address -> the address. */
export function displayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1]?.trim()) return m[1].trim();
  if (m && m[2]) return m[2].trim();
  return from.trim();
}

/**
 * Strip the invisible junk marketers stuff into preheaders (zero-width chars,
 * figure spaces, combining grapheme joiner) plus any literal HTML entities that
 * survived, then collapse whitespace. Turns spacer soup into blank space.
 */
export function cleanText(s: string): string {
  return s
    .replace(/&#\d+;|&#x[0-9a-f]+;/gi, " ") // literal numeric entities (double-encoded spacers)
    .replace(/&(zwnj|zwj|nbsp|shy|ensp|emsp|thinsp);/gi, " ") // literal named spacers
    .replace(/[͏​-‍ ⁠﻿­ ]/g, " ") // invisible/spacer chars
    .replace(/[ \t]{2,}/g, " ") // collapse runs of spaces
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // at most one blank line
    .trim();
}

/**
 * Prefer a real HTML renderer if the user has one (same tools aerc/nmail use);
 * fall back to the html-to-text library. Order matches nmail's html2nmail.
 */
export function renderHtml(html: string): string {
  const tools: Array<[string, string[]]> = [
    ["pandoc", ["-f", "html", "-t", "plain"]],
    ["w3m", ["-dump", "-T", "text/html", "-cols", "100", "-o", "display_image=false"]],
    ["lynx", ["-stdin", "-dump", "-nolist", "-width=100"]],
    ["elinks", ["-dump"]],
  ];
  for (const [cmd, args] of tools) {
    try {
      const r = Bun.spawnSync([cmd, ...args], { stdin: Buffer.from(html) });
      if (r.exitCode === 0) return r.stdout.toString();
    } catch {
      /* not installed — try the next */
    }
  }
  return htmlToTextLib(html, {
    wordwrap: false, // let the TUI wrap
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  });
}

/** HTML -> clean terminal text (the two steps above, in the usual order). */
export function htmlToPlain(html: string): string {
  return cleanText(renderHtml(html));
}
