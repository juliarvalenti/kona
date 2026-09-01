import { test, expect } from "bun:test";
import { renderMarkdown, markdownToText, cleanMarkdown } from "../sdk/markdown.ts";
import { theme } from "../core/config.ts";
import type { ViewNode } from "../sdk/index.ts";

/**
 * The markdown renderer, held to the two things that make it worth having: it
 * emits NODES (never ANSI, which corrupts OpenTUI's layout) and it WRAPS long
 * text instead of truncating it.
 */

type Leaf = { text: string; color?: string; dim?: boolean; bg?: string };

/** Every text leaf in a tree, in reading order. */
function leaves(nodes: ViewNode[]): Leaf[] {
  const out: Leaf[] = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return void out.push({ text: n });
    if (n.kind === "text") return void out.push({ text: n.text, color: n.color, dim: n.dim, bg: n.bg });
    if (n.kind === "row" || n.kind === "col" || n.kind === "box") n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** The kinds a tree contains — nothing exotic should ever appear. */
function kinds(nodes: ViewNode[]): Set<string> {
  const out = new Set<string>();
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return void out.add("string");
    out.add(n.kind);
    if (n.kind === "row" || n.kind === "col" || n.kind === "box") n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

const said = (nodes: ViewNode[]) => leaves(nodes).map((l) => l.text);

// --- The hard constraint -------------------------------------------------

test("emits view nodes only — no ANSI escapes anywhere", () => {
  const doc =
    "# Title\n\n**bold** *em* `code` [link](https://x.dev)\n\n> quote\n\n```ts\nconst x = 1;\n```\n\n- a\n- b\n";
  const nodes = renderMarkdown(doc, { width: 40 });
  // A raw escape in a TextRenderable miscounts the row's width and corrupts
  // the layout — the whole reason this renderer exists instead of `glow`.
  for (const leaf of leaves(nodes)) expect(leaf.text).not.toMatch(/[\u001b\u009b]/);
  // ...and only vocabulary the host actually draws.
  for (const k of kinds(nodes)) expect(["text", "row", "col", "box", "spacer"]).toContain(k);
});

test("a long paragraph wraps to the width instead of truncating", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const nodes = renderMarkdown(words.join(" "), { width: 30 });
  const lines = markdownToText(words.join(" "), { width: 30 }).split("\n");
  expect(lines.length).toBeGreaterThan(4);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  // every word survives the wrap — nothing is dropped or elided
  for (const w of words) expect(lines.join(" ")).toContain(w);
  expect(said(nodes).join(" ")).not.toContain("…");
});

test("a word longer than the frame is split, not overflowed", () => {
  const url = `https://example.com/${"x".repeat(120)}`;
  const lines = markdownToText(url, { width: 24 }).split("\n");
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(24);
  expect(lines.join("")).toContain("x".repeat(120));
});

// --- Blocks --------------------------------------------------------------

test("h1 is accented and ruled; deeper headings are not", () => {
  const t = theme();
  const h1 = leaves(renderMarkdown("# Title", { width: 20 }));
  expect(h1[0]).toMatchObject({ text: "Title", color: t.accent });
  expect(h1[1]!.text).toBe("─".repeat(5)); // a rule the width of the title
  const h3 = leaves(renderMarkdown("### Small", { width: 20 }));
  expect(h3).toHaveLength(1);
  expect(h3[0]).toMatchObject({ text: "Small", color: t.key });
});

test("setext headings are headings too", () => {
  expect(said(renderMarkdown("Title\n=====", { width: 20 }))[0]).toBe("Title");
  expect(said(renderMarkdown("Sub\n---", { width: 20 }))[0]).toBe("Sub");
  // ...but a bare rule is still a rule
  expect(said(renderMarkdown("---", { width: 10 }))).toEqual(["─".repeat(10)]);
});

test("bullet, ordered and task lists carry their markers", () => {
  expect(markdownToText("- one\n- two\n", { width: 30 })).toBe("• one\n• two");
  expect(markdownToText("3. three\n4. four\n", { width: 30 })).toBe("3. three\n4. four");
  expect(markdownToText("- [ ] todo\n- [x] done\n", { width: 30 })).toBe("• [ ] todo\n• [x] done");
  // a numbered list under a bulleted one is its OWN list, not more bullets
  expect(markdownToText("- a\n\n1. b\n", { width: 30 })).toBe("• a\n\n1. b");
});

test("a nested list is indented under its parent item", () => {
  expect(markdownToText("- outer\n  - inner\n- next\n", { width: 30 })).toBe("• outer\n  ◦ inner\n• next");
});

test("a list item's wrapped body hangs under its marker", () => {
  const out = markdownToText("- a body long enough to need two lines here\n", { width: 22 }).split("\n");
  expect(out[0]).toStartWith("• ");
  expect(out[1]).toStartWith("  "); // hanging indent, aligned past the marker
  expect(out[1]!.trim()).not.toBe("");
});

test("a blockquote gets a gutter as tall as its content", () => {
  const md = "> one two three four five six seven\n";
  const out = markdownToText(md, { width: 20 }).split("\n");
  expect(out.length).toBeGreaterThan(1);
  for (const line of out) expect(line).toStartWith("│ ");
  expect(kinds(renderMarkdown(md, { width: 20 }))).toContain("row");
});

test("a fenced block keeps its text verbatim, shaded and unparsed", () => {
  const nodes = renderMarkdown("```ts\nconst a = **not bold**;\n```", { width: 40 });
  const code = nodes[0];
  expect(typeof code === "object" && code.kind).toBe("box");
  if (typeof code === "object" && code.kind === "box") {
    expect(code.opts.border).toBe(false);
    expect(code.opts.bg).toBe(theme().field);
  }
  const lines = said(nodes);
  expect(lines[0]!.trim()).toBe("ts"); // the language, muted inside the block
  expect(lines[1]).toContain("const a = **not bold**;"); // markers stay literal
  for (const l of leaves(nodes)) expect(l.bg).toBe(theme().field);
});

test("an unterminated fence renders what it has instead of eating the parser", () => {
  const out = markdownToText("text\n\n```\nunclosed\n", { width: 30 });
  expect(out).toContain("text");
  expect(out).toContain("unclosed");
});

test("an indented block is code", () => {
  expect(markdownToText("    kona call timer start\n", { width: 40 })).toBe("kona call timer start");
});

test("a pipe table becomes aligned columns, squeezed to fit", () => {
  const md = "| key | does |\n| --- | ---- |\n| space | pause/resume |\n| a | +1m |\n";
  const wide = markdownToText(md, { width: 40 }).split("\n");
  expect(wide[0]).toBe("key    does");
  expect(wide[1]).toBe("space  pause/resume");
  for (const line of markdownToText(md, { width: 14 }).split("\n")) {
    expect(line.length).toBeLessThanOrEqual(14);
  }
});

// --- Inline --------------------------------------------------------------

test("emphasis, strong, code and strike each get their own style", () => {
  const t = theme();
  const nodes = renderMarkdown("plain **strong** *em* `code` ~~gone~~", { width: 60 });
  const by = (s: string) => leaves(nodes).find((l) => l.text === s)!;
  expect(by("strong").color).toBe(t.key);
  expect(by("em").color).toBe(t.alt);
  expect(by("code").bg).toBe(t.field);
  expect(by("gone").dim).toBe(true);
  // one line, many styles: a row of spans, never one string of escapes
  expect(typeof nodes[0] === "object" && nodes[0].kind).toBe("row");
});

test("a link shows its label and keeps the URL — or drops it on request", () => {
  const nodes = renderMarkdown("see [the docs](https://kona.dev/docs) now", { width: 60 });
  expect(leaves(nodes).find((l) => l.text === "the docs")!.color).toBe(theme().accent);
  expect(said(nodes).join("")).toContain("(https://kona.dev/docs)");
  expect(markdownToText("see [the docs](https://kona.dev/docs)", { width: 60, links: "hide" })).toBe("see the docs");
  // a bare URL is a link on its own
  expect(markdownToText("go to https://kona.dev now", { width: 60 })).toBe("go to https://kona.dev now");
  // ...and an image is named rather than silently dropped
  expect(markdownToText("![a chart](x.png)", { width: 30 })).toBe("[image: a chart]");
});

test("inline code and escapes keep their markers out of the render", () => {
  expect(markdownToText("use `**not bold**` here", { width: 40 })).toBe("use **not bold** here");
  expect(markdownToText("a \\*literal\\* star", { width: 40 })).toBe("a *literal* star");
  expect(markdownToText("snake_case_name stays whole", { width: 40 })).toBe("snake_case_name stays whole");
});

test("a hard break splits the line; a soft one does not", () => {
  expect(markdownToText("one  \ntwo", { width: 40 })).toBe("one\ntwo");
  expect(markdownToText("one\ntwo", { width: 40 })).toBe("one two");
  // ...unless the surface is a chat or a notepad, where enter means enter
  expect(markdownToText("one\ntwo", { width: 40, breaks: true })).toBe("one\ntwo");
  // a break is still only a break: a line too long for the frame still wraps
  const long = markdownToText("aaa bbb ccc ddd\neee", { width: 8, breaks: true });
  expect(long).toBe("aaa bbb\nccc ddd\neee");
});

// --- The edges -----------------------------------------------------------

test("nothing in, nothing out", () => {
  expect(renderMarkdown("", { width: 40 })).toEqual([]);
  expect(renderMarkdown("   \n\n  ", { width: 40 })).toEqual([]);
  expect(markdownToText("", { width: 40 })).toBe("");
});

test("maxLines caps a preview and says how much was left", () => {
  const doc = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n\n");
  const out = markdownToText(doc, { width: 30, maxLines: 5 }).split("\n");
  expect(out.length).toBeLessThanOrEqual(6); // the cap, plus the tail
  expect(out[out.length - 1]).toMatch(/… \d+ more lines/);
  // a document that fits keeps quiet
  expect(markdownToText("short", { width: 30, maxLines: 5 })).toBe("short");
});

test("cleanMarkdown normalizes without eating markdown's own whitespace", () => {
  expect(cleanMarkdown("a\r\nb")).toBe("a\nb");
  expect(cleanMarkdown("a\n\n\n\n\nb")).toBe("a\n\nb");
  expect(cleanMarkdown("a\u200bb\u2060c")).toBe("abc"); // zero-width junk from web editors
  expect(cleanMarkdown("\ttab")).toBe("    tab");
  expect(cleanMarkdown("hard break  \nnext")).toBe("hard break  \nnext"); // the trailing pair survives
});

test("the renderer is pure — same input, same nodes", () => {
  const doc = "# a\n\n- b\n\n> c\n";
  expect(renderMarkdown(doc, { width: 30 })).toEqual(renderMarkdown(doc, { width: 30 }));
});
