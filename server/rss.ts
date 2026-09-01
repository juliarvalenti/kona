import { homedir } from "node:os";
import { join } from "node:path";
import { convert as htmlToText } from "html-to-text";

/**
 * RSS/Atom for kona — no auth, no API, just HTTP + a small parser. Feeds are
 * declared once in a config file; the daemon fetches them on a tick so YOU
 * browse the river with j/k/l and an AGENT can call the same verbs (refresh,
 * search, open) headlessly.
 *
 * Config:
 *   ~/.config/kona/rss.toml   (override with KONA_RSS_CONFIG)
 *
 *     feeds = ["https://news.ycombinator.com/rss"]
 *
 *     [[feeds]]
 *     name = "xkcd"
 *     url  = "https://xkcd.com/atom.xml"
 *
 * The XML parsing below is deliberately regex-shaped rather than a DOM: feeds
 * are shallow, we want five fields out of each item, and a dependency-free
 * parser keeps the applet honest. Everything pure is exported for unit tests.
 */

export const CONFIG_FILE = process.env.KONA_RSS_CONFIG ?? join(homedir(), ".config", "kona", "rss.toml");

export interface FeedSource {
  /** Display name. Falls back to the feed's own <title>, then its host. */
  name?: string;
  url: string;
}

export interface FeedItem {
  id: string;
  feed: string;
  title: string;
  link: string;
  author: string;
  /** Epoch ms; 0 when the feed gave no parseable date. */
  published: number;
  /** Plain-text body (HTML flattened), ready to print in the reader. */
  summary: string;
}

export interface FeedError {
  feed: string;
  message: string;
}

// --- config -----------------------------------------------------------------

function asSource(v: unknown): FeedSource | null {
  if (typeof v === "string") return v.trim() ? { url: v.trim() } : null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!url) return null;
    return typeof o.name === "string" && o.name ? { name: o.name, url } : { url };
  }
  return null;
}

/**
 * Accepts the three shapes people reach for: a list of URLs, `[[feeds]]`
 * tables, or a `[feeds]` table of name = url. Unknown entries are skipped
 * rather than fatal — one bad line shouldn't blank the reader.
 */
export function parseConfig(toml: string): FeedSource[] {
  const doc = Bun.TOML.parse(toml) as Record<string, unknown>;
  const raw = doc.feeds ?? doc.feed ?? doc.sources;
  if (Array.isArray(raw)) return raw.map(asSource).filter((s): s is FeedSource => !!s);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([name, v]): FeedSource | null => {
        const s = asSource(v);
        return s ? { name: s.name ?? name, url: s.url } : null;
      })
      .filter((s): s is FeedSource => !!s);
  }
  return [];
}

/** Feeds from the config file. Missing file -> [] (the applet prompts). */
export async function readFeeds(): Promise<FeedSource[]> {
  const file = Bun.file(CONFIG_FILE);
  if (!(await file.exists())) return [];
  try {
    return parseConfig(await file.text());
  } catch (e) {
    throw new Error(`bad ${CONFIG_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- XML ---------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Unwrap CDATA and decode the entity set feeds actually use. */
export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n: string) => ENTITIES[n.toLowerCase()] ?? _);
}

/** First `<tag>…</tag>` body, decoded. "" when absent. */
export function tagText(xml: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  return decodeXml(re.exec(xml)?.[1] ?? "").trim();
}

/** An attribute off the first `<tag …>` (self-closing included). */
export function tagAttr(xml: string, name: string, attr: string): string {
  const tag = new RegExp(`<${name}(\\s[^>]*?)/?>`, "i").exec(xml)?.[1];
  if (!tag) return "";
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return decodeXml(m?.[1] ?? m?.[2] ?? "").trim();
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

/**
 * HTML (or plain) item body -> readable text. Image alt text is kept (for a
 * comic feed the alt text IS the post) but the src is not; links lose their
 * hrefs. Anything that doesn't look like markup passes through untouched.
 */
export function textify(s: string): string {
  const withAlt = s.replace(/<img\b[^>]*?\balt\s*=\s*"([^"]*)"[^>]*>/gi, (_, alt: string) => (alt.trim() ? ` ${alt} ` : " "));
  const out = /<[a-z!/]/i.test(s)
    ? htmlToText(withAlt, {
        wordwrap: false, // the TUI wraps
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
        ],
      })
    : s;
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function date(...candidates: string[]): number {
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Atom `<link rel="alternate" href>`, else the first link with an href. */
function atomLink(entry: string): string {
  const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const pick = links.find((l) => /rel\s*=\s*["']?alternate/i.test(l)) ?? links.find((l) => !/rel\s*=/i.test(l)) ?? links[0];
  return pick ? tagAttr(pick, "link", "href") : "";
}

function author(block: string): string {
  const dc = tagText(block, "dc:creator");
  if (dc) return dc;
  const a = tagText(block, "author");
  if (!a) return "";
  const name = tagText(a, "name"); // Atom nests <author><name>
  return name || a;
}

/**
 * Parse an RSS 2.0 / RDF / Atom document into normalized items. `source` names
 * the feed when the document doesn't (and wins when the user named it).
 */
export function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  const items = blocks(xml, "item");
  const entries = items.length ? items : blocks(xml, "entry");
  const isAtom = items.length === 0;

  // The channel <title> — take it from the document with the items removed so
  // an item's own <title> can't shadow it.
  const head = xml.replace(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "");
  const feed = source.name || tagText(head, "title") || host(source.url);

  return entries.map((block, i) => {
    const link = (isAtom ? atomLink(block) : tagText(block, "link")) || tagText(block, "guid");
    const body =
      tagText(block, "content:encoded") ||
      tagText(block, "content") ||
      tagText(block, "description") ||
      tagText(block, "summary");
    return {
      id: tagText(block, "guid") || tagText(block, "id") || link || `${source.url}#${i}`,
      feed,
      title: tagText(block, "title") || "(untitled)",
      link,
      author: author(block),
      published: date(tagText(block, "pubDate"), tagText(block, "published"), tagText(block, "updated"), tagText(block, "dc:date")),
      summary: textify(body),
    };
  });
}

// --- fetching ----------------------------------------------------------------

export interface River {
  items: FeedItem[];
  errors: FeedError[];
  feeds: number;
}

async function fetchOne(source: FeedSource, perFeed: number): Promise<FeedItem[]> {
  const res = await fetch(source.url, {
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8", "user-agent": "kona-rss/0.1" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), source).slice(0, perFeed);
}

/**
 * Fetch every feed in parallel and merge into one newest-first river. A feed
 * that fails is reported alongside the items that did load — one dead host
 * never empties the reader.
 */
export async function fetchRiver(sources: FeedSource[], perFeed = 50): Promise<River> {
  const errors: FeedError[] = [];
  const settled = await Promise.all(
    sources.map(async (s) => {
      try {
        return await fetchOne(s, perFeed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ feed: s.name || host(s.url), message: /timeout|abort/i.test(msg) ? "timed out" : msg });
        return [] as FeedItem[];
      }
    }),
  );
  const items = settled.flat();
  items.sort((a, b) => b.published - a.published);
  return { items, errors, feeds: sources.length };
}

/** Case-insensitive match across title, feed, author and body. */
export function matches(item: FeedItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${item.title} ${item.feed} ${item.author} ${item.summary}`.toLowerCase().includes(needle);
}
