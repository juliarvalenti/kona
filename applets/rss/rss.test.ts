import { test, expect } from "bun:test";
import { parseConfig, parseFeed, decodeXml, tagText, tagAttr, textify, matches } from "../../server/rss.ts";
import { renderApplet } from "../../sdk/testing.ts";

/** Pure feed parsing + rendering — no network, no config file. */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Hacker News</title><link>https://news.ycombinator.com/</link>
  <item>
    <title>Show HN: &lt;kona&gt; applets</title>
    <link>https://example.com/a</link>
    <guid isPermaLink="false">hn-1</guid>
    <pubDate>Mon, 01 Sep 2026 06:12:00 +0000</pubDate>
    <dc:creator>ada</dc:creator>
    <description><![CDATA[<p>A <b>bimodal</b> applet runtime.</p><a href="https://x">docs</a>]]></description>
  </item>
  <item>
    <title>Second</title><link>https://example.com/b</link>
    <pubDate>Sun, 31 Aug 2026 10:00:00 +0000</pubDate>
    <description>plain text</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>xkcd.com</title>
  <entry>
    <title>Barrel</title>
    <link href="https://xkcd.com/1/" rel="alternate"></link>
    <id>tag:xkcd,1</id>
    <updated>2026-08-30T00:00:00Z</updated>
    <author><name>Randall</name></author>
    <summary type="html">&lt;img src="https://imgs.xkcd.com/barrel.png" alt="A boy sits in a barrel." /&gt;</summary>
  </entry>
</feed>`;

test("parseConfig accepts a URL list, [[feeds]] tables, and a name = url table", () => {
  expect(parseConfig('feeds = ["https://a.com/rss", "https://b.com/rss"]')).toEqual([
    { url: "https://a.com/rss" },
    { url: "https://b.com/rss" },
  ]);
  expect(parseConfig('[[feeds]]\nname = "xkcd"\nurl = "https://xkcd.com/atom.xml"\n')).toEqual([
    { name: "xkcd", url: "https://xkcd.com/atom.xml" },
  ]);
  expect(parseConfig('[feeds]\nhn = "https://news.ycombinator.com/rss"\n')).toEqual([
    { name: "hn", url: "https://news.ycombinator.com/rss" },
  ]);
});

test("parseConfig skips junk entries and an absent feeds key", () => {
  expect(parseConfig('feeds = ["https://a.com/rss", "", 7]')).toEqual([{ url: "https://a.com/rss" }]);
  expect(parseConfig("other = 1")).toEqual([]);
});

test("decodeXml unwraps CDATA and decodes named + numeric entities", () => {
  expect(decodeXml("<![CDATA[a & b]]>")).toBe("a & b");
  expect(decodeXml("&lt;kona&gt; &amp; &#39;quotes&#x2019;")).toBe("<kona> & 'quotes’");
});

test("tagText and tagAttr read the first match, self-closing tags included", () => {
  expect(tagText("<a><title>one</title><title>two</title></a>", "title")).toBe("one");
  expect(tagText("<a></a>", "title")).toBe("");
  expect(tagAttr('<link href="https://x/" rel="alternate"/>', "link", "href")).toBe("https://x/");
  expect(tagAttr("<link href='https://y/'>", "link", "href")).toBe("https://y/");
});

test("textify flattens HTML, keeps image alt text, and drops srcs and hrefs", () => {
  expect(textify("<p>hi <b>there</b></p>")).toBe("hi there");
  expect(textify('<img src="https://x/y.png" alt="a comic caption" />')).toBe("a comic caption");
  expect(textify('<a href="https://x">docs</a>')).toBe("docs");
  expect(textify("already plain")).toBe("already plain");
});

test("parseFeed reads RSS items: guid, link, date, dc:creator, HTML body", () => {
  const items = parseFeed(RSS, { url: "https://news.ycombinator.com/rss" });
  expect(items).toHaveLength(2);
  const first = items[0]!;
  expect(first.id).toBe("hn-1");
  expect(first.feed).toBe("Hacker News"); // channel <title>, not the item's
  expect(first.title).toBe("Show HN: <kona> applets");
  expect(first.link).toBe("https://example.com/a");
  expect(first.author).toBe("ada");
  expect(first.published).toBe(Date.parse("Mon, 01 Sep 2026 06:12:00 +0000"));
  expect(first.summary).toContain("A bimodal applet runtime.");
  expect(first.summary).not.toContain("<");
  // No guid -> fall back to the link.
  expect(items[1]!.id).toBe("https://example.com/b");
});

test("parseFeed reads Atom entries: alternate link, nested author, updated", () => {
  const items = parseFeed(ATOM, { url: "https://xkcd.com/atom.xml" });
  expect(items).toHaveLength(1);
  const it = items[0]!;
  expect(it.id).toBe("tag:xkcd,1");
  expect(it.feed).toBe("xkcd.com");
  expect(it.link).toBe("https://xkcd.com/1/");
  expect(it.author).toBe("Randall");
  expect(it.published).toBe(Date.parse("2026-08-30T00:00:00Z"));
  expect(it.summary).toBe("A boy sits in a barrel.");
});

test("a configured name wins over the feed's own title", () => {
  expect(parseFeed(ATOM, { name: "XKCD", url: "https://xkcd.com/atom.xml" })[0]!.feed).toBe("XKCD");
});

test("matches searches title, feed, author and body; empty query matches all", () => {
  const it = parseFeed(RSS, { url: "https://x" })[0]!;
  expect(matches(it, "bimodal")).toBe(true); // body
  expect(matches(it, "HACKER")).toBe(true); // feed, case-insensitive
  expect(matches(it, "ada")).toBe(true); // author
  expect(matches(it, "nope")).toBe(false);
  expect(matches(it, "")).toBe(true);
});

// --- rendering ---------------------------------------------------------------

const ITEMS = [
  ...parseFeed(RSS, { url: "https://news.ycombinator.com/rss" }),
  ...parseFeed(ATOM, { url: "https://xkcd.com/atom.xml" }),
];

test("rss river lists feed, title and unread dots", async () => {
  const frame = await renderApplet(
    "rss",
    { configured: true, feeds: 2, items: ITEMS, read: [ITEMS[1]!.id], cursor: 0 },
    88,
    16,
  );
  expect(frame).toContain("Hacker News");
  expect(frame).toContain("xkcd.com");
  expect(frame).toContain("Barrel");
  expect(frame).toContain("3 items · 2 feeds");
  expect(frame).toContain("●"); // unread dot on the items not in `read`
});

test("rss reader shows title, source, link and body", async () => {
  const frame = await renderApplet("rss", { configured: true, feeds: 2, items: ITEMS, open: ITEMS[2] }, 88, 14);
  expect(frame).toContain("Barrel");
  expect(frame).toContain("xkcd.com");
  expect(frame).toContain("Randall");
  expect(frame).toContain("https://xkcd.com/1/");
  expect(frame).toContain("A boy sits in a barrel.");
});

test("rss prompts for a config file when no feeds are set up", async () => {
  const frame = await renderApplet("rss", {}, 72, 16);
  expect(frame).toContain("No feeds configured");
  expect(frame).toContain("rss.toml");
});

test("rss surfaces a per-feed fetch error next to the items that did load", async () => {
  const frame = await renderApplet(
    "rss",
    { configured: true, feeds: 2, items: ITEMS, feedErrors: [{ feed: "lobste.rs", message: "HTTP 503" }] },
    88,
    14,
  );
  expect(frame).toContain("lobste.rs: HTTP 503");
  expect(frame).toContain("Show HN"); // the good feed still renders
});
