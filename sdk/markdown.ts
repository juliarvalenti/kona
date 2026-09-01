import { theme } from "../core/config.ts";
import { type Color, type ViewNode, text, row, col, box, spacer } from "./index.ts";
import { divider, table } from "./components.ts";

/**
 * Markdown -> view nodes. The sibling of the mail renderer: `server/mailtext.ts`
 * turns the HTML most email is made of into terminal text, and this turns the
 * MARKDOWN most chat, notes and agent output is made of into kona view nodes.
 *
 * The hard constraint, learned on email: the output is NODES, never ANSI. A
 * raw `\x1b[1m` inside a TextRenderable miscounts the string's width and
 * corrupts OpenTUI's layout, so piping `glow` (or any styling pager) through
 * the view is not an option however good it looks in a shell. Everything here
 * is a `text`/`row`/`col`/`box` the host already knows how to draw, which also
 * means it themes itself: name a role in `theme()` and one config file
 * recolors every document kona renders.
 *
 * The second constraint is WIDTH. A terminal renderer that truncates long
 * paragraphs loses the text; this one wraps them, and because a styled line is
 * a `row` of spans (the host word-wraps a single `text` node, but it cannot
 * wrap five of them side by side and keep them in order) the wrapping is ours
 * to do, span-aware, before any node exists.
 *
 * What it understands: ATX and setext headings, paragraphs with emphasis,
 * strong, strikethrough, inline code, links, images and autolinks; bullet,
 * ordered and task lists, nested; blockquotes; fenced and indented code
 * blocks; thematic breaks; GFM pipe tables. What it deliberately does not:
 * reference links, footnotes and raw HTML blocks, which read as their literal
 * text rather than disappearing.
 *
 * Three entry points, mirroring the mail module's shape:
 *
 *   renderMarkdown(md, { width })  the document as nodes — what a view wants
 *   markdownToText(md, { width })  the same render, flattened to plain text —
 *                                  what a record row, a dash card or a desktop
 *                                  notification wants
 *   cleanMarkdown(md)              the `cleanText()` pass: invisible junk out,
 *                                  newlines normalized. Run for you by both.
 */

/** How a document is rendered. Everything is optional; `width` is what matters. */
export interface MarkdownOpts {
  /** Columns to wrap to. Default 80 — pass `ctx.width` and paragraphs fit. */
  width?: number;
  /** Body text color. Default `theme().fg`. */
  color?: Color;
  /** Headings, links and list markers. Default `theme().accent`. */
  accent?: Color;
  /**
   * What to do with a link's URL: show it dim after the label (the default —
   * a terminal has nothing to click, so the URL IS the link), or drop it and
   * keep only the label.
   */
  links?: "inline" | "hide";
  /**
   * Treat a single newline as a LINE BREAK rather than markdown's soft wrap —
   * what GitHub comments, Slack and every chat surface do, and what a human
   * typing a list into a notepad means. Off by default (CommonMark: a
   * paragraph re-wraps to the frame).
   */
  breaks?: boolean;
  /**
   * Stop after this many rendered LINES and end with a dim "… N more lines".
   * For previews — a chat bubble, a card — where the document is longer than
   * the space it was given.
   */
  maxLines?: number;
}

/** The resolved palette one render draws with. */
interface Palette {
  fg: Color;
  dim: Color;
  muted: Color;
  accent: Color;
  /** Emphasis (`*em*`) — a tint, because rendering emphasis DIM inverts it. */
  em: Color;
  /** Strong (`**bold**`) — brighter than the body, the terminal's only "bolder". */
  strong: Color;
  /** Fill behind code, inline and fenced alike. */
  codeBg: Color;
  ok: Color;
}

function palette(opts: MarkdownOpts): Palette {
  const t = theme();
  return {
    fg: opts.color ?? t.fg,
    dim: t.dim,
    muted: t.muted,
    accent: opts.accent ?? t.accent,
    em: t.alt,
    strong: t.key,
    codeBg: t.field,
    ok: t.ok,
  };
}

// --- The clean pass ------------------------------------------------------

/**
 * The `cleanText()` of markdown: normalize newlines and tabs, drop the
 * invisible characters that ride in from web editors and mail, and cap a run
 * of blank lines at one. Gentler than its mail cousin on purpose — trailing
 * spaces are a hard line break and leading spaces are code, so neither is
 * collapsed here.
 */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad\u034f]/g, "") // zero-width spacers and joiners
    .replace(/\u00a0/g, " ") // nbsp — a space that never wraps
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

// --- Blocks --------------------------------------------------------------

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "code"; lang?: string; lines: string[] }
  | { t: "quote"; children: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "rule" }
  | { t: "table"; header: string[]; rows: string[][] };

const RE = {
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  fence: /^( {0,3})(```+|~~~+)\s*([^\s`]*)/,
  rule: /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/,
  quote: /^ {0,3}>\s?/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/,
  setext: /^ {0,3}(=+|-+)\s*$/,
  divider: /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/,
};

/** Does this line open a block that a paragraph must stop before? */
function startsBlock(line: string): boolean {
  return (
    !line.trim() ||
    RE.heading.test(line) ||
    RE.fence.test(line) ||
    RE.rule.test(line) ||
    RE.quote.test(line) ||
    RE.item.test(line)
  );
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Parse a document (already cleaned) into blocks. Recursive: quotes and list items re-enter here. */
function parseBlocks(lines: string[], breaks = false): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code: everything to the closing fence is literal, so this is
    // checked before anything that could match inside it.
    const fence = line.match(RE.fence);
    if (fence) {
      const [pad, ticks, lang] = [fence[1]!, fence[2]!, fence[3] ?? ""];
      const close = new RegExp(`^ {0,3}${ticks[0] === "`" ? "`" : "~"}{${ticks.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence, or the end of the document
      out.push({ t: "code", lang: lang || undefined, lines: body.map((l) => l.slice(pad.length)) });
      continue;
    }

    if (RE.rule.test(line)) {
      out.push({ t: "rule" });
      i++;
      continue;
    }

    const heading = line.match(RE.heading);
    if (heading) {
      out.push({ t: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }

    if (RE.quote.test(line)) {
      const body: string[] = [];
      // A quote runs while its lines are marked, and swallows lazy
      // continuation lines (a wrapped quote whose second line lost its `>`).
      while (i < lines.length && (RE.quote.test(lines[i]!) || (lines[i]!.trim() && !startsBlock(lines[i]!)))) {
        body.push(lines[i]!.replace(RE.quote, ""));
        i++;
      }
      out.push({ t: "quote", children: parseBlocks(body, breaks) });
      continue;
    }

    if (RE.item.test(line)) {
      const [list, next] = parseList(lines, i, breaks);
      out.push(list);
      i = next;
      continue;
    }

    // An indented chunk that is not continuing a list is a code block.
    if (indentOf(line) >= 4 && out[out.length - 1]?.t !== "list") {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]!) >= 4 || !lines[i]!.trim())) body.push(lines[i++]!.slice(4));
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      out.push({ t: "code", lines: body });
      continue;
    }

    // A pipe table announces itself with its delimiter row.
    if (line.includes("|") && lines[i + 1] && RE.divider.test(lines[i + 1]!)) {
      const cells = (l: string) =>
        l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ t: "table", header, rows });
      continue;
    }

    // Otherwise: a paragraph, to the next blank line or block opener.
    const para: string[] = [line];
    i++;
    while (i < lines.length && !startsBlock(lines[i]!)) {
      const setext = lines[i]!.match(RE.setext);
      if (setext) break;
      para.push(lines[i]!);
      i++;
    }
    const setext = i < lines.length ? lines[i]!.match(RE.setext) : null;
    if (setext) {
      i++;
      out.push({ t: "heading", level: setext[1]!.startsWith("=") ? 1 : 2, text: para.join(" ").trim() });
      continue;
    }
    out.push({ t: "para", text: joinParagraph(para, breaks) });
  }

  return out;
}

/**
 * Paragraph lines as one string: a newline is a SPACE (markdown's soft wrap —
 * we re-wrap to the terminal's width), unless the line asked for a hard break
 * with two trailing spaces or a backslash.
 */
function joinParagraph(lines: string[], breaks: boolean): string {
  return lines
    .map((l, n) => {
      const body = l.trim();
      if (n === lines.length - 1) return body;
      const hard = breaks || /\s{2,}$/.test(l) || body.endsWith("\\");
      return (hard ? body.replace(/\\$/, "") : body) + (hard ? "\n" : " ");
    })
    .join("");
}

/** One list and where it ends: `[block, index of the first line after it]`. */
function parseList(lines: string[], from: number, breaks: boolean): [Block, number] {
  const first = lines[from]!.match(RE.item)!;
  const ordered = /\d/.test(first[2]!);
  const indent = first[1]!.length;
  const items: Block[][] = [];
  let buf: string[] = [];
  let content = indent + first[2]!.length + first[3]!.length;
  let i = from;
  let blanks = 0;

  const flush = () => {
    if (buf.length) items.push(parseBlocks(buf, breaks));
    buf = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      // One blank line is a loose list; two end it.
      if (++blanks > 1) break;
      buf.push("");
      i++;
      continue;
    }
    const item = line.match(RE.item);
    if (item && item[1]!.length <= indent) {
      // A marker of the other kind starts a NEW list, not another item of this
      // one: "1." under a run of "-" is a numbered list that happens to follow.
      if (/\d/.test(item[2]!) !== ordered) break;
      // A sibling item — and a blank line before it was a separator, not content.
      if (blanks) buf.pop();
      blanks = 0;
      flush();
      content = item[1]!.length + item[2]!.length + item[3]!.length;
      buf.push(item[4]!);
      i++;
      continue;
    }
    // Continuation: indented under the marker, or a lazy wrapped line. Anything
    // else (an unindented heading, a fence) ends the list.
    const cont = indentOf(line) > indent || (!blanks && !startsBlock(line));
    if (!cont) break;
    if (blanks && indentOf(line) <= indent) break;
    blanks = 0;
    buf.push(line.slice(Math.min(content, indentOf(line))));
    i++;
  }
  while (buf.length && !buf[buf.length - 1]!.trim()) buf.pop();
  flush();

  const start = ordered ? parseInt(first[2]!, 10) || 1 : 1;
  return [{ t: "list", ordered, start, items }, i];
}

// --- Inline spans --------------------------------------------------------

type SpanStyle = "text" | "strong" | "em" | "strike" | "code" | "link" | "url";

interface Span {
  text: string;
  style: SpanStyle;
}

/** Characters that can start something inline. Everything else is just text. */
const MARKERS = new Set(["\\", "`", "[", "!", "<", "~", "*", "_", "h"]);

/**
 * A line of markdown as styled spans. Recursive on emphasis, so `**a *b***`
 * keeps its inner run; code spans win over everything, as they must (a
 * backtick run is literal to its close).
 */
function parseInline(src: string, style: SpanStyle = "text", links: "inline" | "hide" = "inline"): Span[] {
  const out: Span[] = [];
  let run = "";
  const push = (t: string, s: SpanStyle) => {
    if (!t) return;
    if (run) {
      out.push({ text: run, style });
      run = "";
    }
    out.push({ text: t, style: s });
  };
  const nest = (t: string, s: SpanStyle) => {
    if (run) {
      out.push({ text: run, style });
      run = "";
    }
    out.push(...parseInline(t, s, links));
  };

  let i = 0;
  while (i < src.length) {
    // Only a character that could OPEN something is worth cutting the string
    // for; everything else joins the run in hand ("h" is there for a bare
    // https:// link, which has no marker of its own).
    if (!MARKERS.has(src[i]!)) {
      run += src[i];
      i++;
      continue;
    }
    const rest = src.slice(i);
    const prev = i > 0 ? src[i - 1]! : " ";

    const esc = rest.match(/^\\([\\`*_{}[\]()#+\-.!~>|])/);
    if (esc) {
      run += esc[1];
      i += 2;
      continue;
    }

    const code = rest.match(/^(`+)([^]*?)\1/);
    if (code) {
      push(code[2]!.replace(/^ (.*) $/, "$1"), "code");
      i += code[0]!.length;
      continue;
    }

    const media = rest.match(/^(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/);
    if (media) {
      const [bang, label, href] = [media[1]!, media[2]!, media[3] ?? ""];
      if (bang) push(label ? `[image: ${label}]` : "[image]", "url");
      else {
        push(label || href, "link");
        if (href && links === "inline" && label !== href) push(` (${href})`, "url");
      }
      i += media[0]!.length;
      continue;
    }

    const auto = rest.match(/^<((?:https?|mailto):[^>\s]+)>/) ?? rest.match(/^(https?:\/\/[^\s<>()[\]]+)/);
    if (auto) {
      push(auto[1]!, "link");
      i += auto[0]!.length;
      continue;
    }

    const strike = rest.match(/^~~(?=\S)([^]*?\S)~~/);
    if (strike) {
      nest(strike[1]!, "strike");
      i += strike[0]!.length;
      continue;
    }

    const strong = rest.match(/^(\*\*|__)(?=\S)([^]*?\S)\1/);
    if (strong && (strong[1] === "**" || !/\w/.test(prev))) {
      nest(strong[2]!, "strong");
      i += strong[0]!.length;
      continue;
    }

    // `_` only outside a word, so snake_case_names survive intact.
    const em = rest.match(/^(\*|_)(?=\S)([^]*?\S)\1/);
    if (em && (em[1] === "*" || !/\w/.test(prev))) {
      nest(em[2]!, "em");
      i += em[0]!.length;
      continue;
    }

    run += src[i];
    i++;
  }
  if (run) out.push({ text: run, style });
  return merge(out);
}

/** Spans as the text they carry — for the places style has no say (a heading, a table cell). */
const plain = (spans: Span[]): string => spans.map((s) => s.text).join("");

/** Fold neighbouring spans that share a style — fewer nodes, cleaner tests. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.style === s.style) last.text += s.text;
    else if (s.text) out.push({ ...s });
  }
  return out;
}

// --- Wrapping ------------------------------------------------------------

/**
 * Greedy word wrap ACROSS spans: styling never changes where a line breaks,
 * and a break never loses which style a word had. A word longer than the whole
 * width (a URL) is split rather than allowed to overflow the frame.
 */
function wrapSpans(spans: Span[], width: number): Span[][] {
  const w = Math.max(4, Math.floor(width));
  const lines: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  let gap = "";

  const flush = () => {
    lines.push(merge(line));
    line = [];
    used = 0;
    gap = "";
  };

  for (const span of spans) {
    for (const token of span.text.split(/(\n|[ \t]+)/)) {
      if (!token) continue;
      if (token === "\n") {
        flush();
        continue;
      }
      if (/^[ \t]+$/.test(token)) {
        if (used) gap = " ";
        continue;
      }
      let word = token;
      while (word.length) {
        const lead = used ? gap.length : 0;
        if (used && used + lead + word.length > w) flush();
        if (!used && word.length > w) {
          // Nothing to break on: take a full line of it and carry the rest.
          lines.push([{ text: word.slice(0, w), style: span.style }]);
          word = word.slice(w);
          continue;
        }
        if (used && gap) {
          // A space BETWEEN two styles belongs to neither: styling it would
          // put a shaded cell beside every inline code span and stretch a
          // link's underline-by-color past its label.
          const before = line[line.length - 1]?.style ?? span.style;
          line.push({ text: gap, style: before === span.style ? before : "text" });
          used += gap.length;
          gap = "";
        }
        line.push({ text: word, style: span.style });
        used += word.length;
        word = "";
      }
    }
  }
  if (line.length) flush();
  return lines.length ? lines : [[]];
}

// --- Nodes ---------------------------------------------------------------

function spanNode(s: Span, p: Palette): ViewNode {
  switch (s.style) {
    case "strong":
      return text(s.text, { color: p.strong });
    case "em":
      return text(s.text, { color: p.em });
    case "strike":
      // No strikethrough in the vocabulary — struck text reads as retracted,
      // which dim says well enough.
      return text(s.text, { dim: true });
    case "code":
      return text(s.text, { color: p.fg, bg: p.codeBg });
    case "link":
      return text(s.text, { color: p.accent });
    case "url":
      return text(s.text, { dim: true });
    default:
      return text(s.text, { color: p.fg });
  }
}

/** One wrapped line: a bare `text` when it is all one style, a `row` when it isn't. */
function lineNode(spans: Span[], p: Palette): ViewNode {
  if (!spans.length) return spacer();
  if (spans.length === 1) return spanNode(spans[0]!, p);
  return row(spans.map((s) => spanNode(s, p)));
}

const inlineNodes = (src: string, width: number, p: Palette, links: "inline" | "hide"): ViewNode[] =>
  wrapSpans(parseInline(src, "text", links), width).map((l) => lineNode(l, p));

/**
 * Lines a node occupies. Every node here is one we built, so this is exact —
 * which is what lets a blockquote's gutter be exactly as tall as its content
 * and `maxLines` count what a reader will actually see.
 */
function nodeLines(node: ViewNode): number {
  if (typeof node === "string") return 1;
  switch (node.kind) {
    case "col":
      return node.children.reduce((n, c) => n + nodeLines(c), 0);
    case "row":
      return Math.max(1, ...node.children.map(nodeLines));
    case "box":
      return node.children.reduce((n, c) => n + nodeLines(c), 0) + (node.opts.border === false ? 0 : 2);
    default:
      return 1;
  }
}

const heightOf = (nodes: ViewNode[]): number => nodes.reduce((n, c) => n + nodeLines(c), 0);

function renderBlock(b: Block, width: number, p: Palette, opts: MarkdownOpts, depth: number): ViewNode[] {
  const links = opts.links ?? "inline";
  switch (b.t) {
    case "heading": {
      // A heading is one voice: its own inline markers are stripped rather
      // than styled, so `## the **plan**` is a heading, not a heading with a
      // brighter word in it.
      const label = plain(parseInline(b.text, "text", links));
      const color = b.level <= 2 ? p.accent : p.strong;
      const lines = wrapSpans([{ text: label, style: "text" }], width).map(plain);
      // Only the title of the document gets a rule under it; deeper headings
      // are told apart by color and the blank line above them.
      const nodes = lines.map((l) => text(l, { color }));
      return b.level === 1 ? [...nodes, divider(Math.min(width, Math.max(0, ...lines.map((l) => l.length))))] : nodes;
    }
    case "para":
      return inlineNodes(b.text, width, p, links);
    case "rule":
      return [divider(width)];
    case "code": {
      const body = b.lines.length ? b.lines : [""];
      const rows = body.map((l) => text(` ${l}`.padEnd(width), { color: p.fg, bg: p.codeBg }));
      return [
        box(
          [...(b.lang ? [text(` ${b.lang}`, { color: p.muted, bg: p.codeBg })] : []), ...rows],
          { border: false, bg: p.codeBg },
        ),
      ];
    }
    case "quote": {
      const inner = renderBlocks(b.children, Math.max(8, width - 2), p, opts, depth + 1);
      const gutter = col(Array.from({ length: heightOf(inner) }, () => text("│", { color: p.muted })));
      return [row([gutter, col(inner)], { gap: 1 })];
    }
    case "list": {
      const bullets = ["•", "◦", "▪"];
      const out: ViewNode[] = [];
      b.items.forEach((item, n) => {
        const task = taskOf(item);
        const marker = b.ordered
          ? `${b.start + n}.`.padEnd(String(b.start + b.items.length).length + 1)
          : (bullets[depth % bullets.length] ?? "•");
        const lead = `${marker} `;
        const body = renderBlocks(task ? task.rest : item, Math.max(8, width - lead.length), p, opts, depth + 1, true);
        out.push(
          row([
            text(lead, { color: b.ordered ? p.dim : p.accent }),
            col(task ? [row([text(task.done ? "[x] " : "[ ] ", { color: task.done ? p.ok : p.dim }), col(body)])] : body),
          ]),
        );
      });
      return out;
    }
    case "table": {
      const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
      const cells = (r: string[]) =>
        Array.from({ length: cols }, (_, c) => plain(parseInline(r[c] ?? "", "text", "hide")));
      const grid = [cells(b.header), ...b.rows.map(cells)];
      // Share the width out: natural widths, squeezed proportionally when the
      // table is wider than the frame, never below a readable minimum.
      const natural = Array.from({ length: cols }, (_, c) => Math.max(...grid.map((r) => r[c]!.length)));
      const budget = width - 2 * (cols - 1);
      let widths = natural;
      if (natural.reduce((a, n) => a + n, 0) > budget) {
        const scale = budget / natural.reduce((a, n) => a + n, 0);
        widths = natural.map((n) => Math.max(3, Math.floor(n * scale)));
      }
      const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
      return table(
        cells(b.header).map((h, c) => clip(h, widths[c]!)),
        b.rows.map((r) => cells(r).map((cell, c) => clip(cell, widths[c]!))),
        { color: p.fg },
      );
    }
  }
}

/** A task-list item: its checkbox, and the item with the marker taken off. */
function taskOf(item: Block[]): { done: boolean; rest: Block[] } | null {
  const first = item[0];
  if (!first || first.t !== "para") return null;
  const m = first.text.match(/^\[([ xX])\]\s+([^]*)$/);
  if (!m) return null;
  return { done: m[1] !== " ", rest: [{ t: "para", text: m[2]! }, ...item.slice(1)] };
}

/**
 * Blocks, one blank line between them — the document's own rhythm. Inside a
 * list item a sub-list follows its lead paragraph directly (`tight`), because
 * a blank line there breaks the item in two on screen.
 */
function renderBlocks(
  blocks: Block[],
  width: number,
  p: Palette,
  opts: MarkdownOpts,
  depth: number,
  tight = false,
): ViewNode[] {
  const out: ViewNode[] = [];
  blocks.forEach((b, i) => {
    const glued = tight && b.t === "list" && blocks[i - 1]?.t === "para";
    if (i && !glued) out.push(spacer());
    out.push(...renderBlock(b, width, p, opts, depth));
  });
  return out;
}

// --- The entry points ----------------------------------------------------

/**
 * A markdown document as view nodes, wrapped to `width` and themed. Drop the
 * result straight into a view:
 *
 *   col([...renderMarkdown(note.body, { width: W - 1 })])
 *
 * Pure and side-effect free, so a snapshot fixture can assert on what it draws.
 */
export function renderMarkdown(md: string, opts: MarkdownOpts = {}): ViewNode[] {
  const src = cleanMarkdown(md ?? "");
  if (!src.trim()) return [];
  const width = Math.max(8, Math.floor(opts.width ?? 80));
  const p = palette(opts);
  const nodes = renderBlocks(parseBlocks(src.split("\n"), opts.breaks ?? false), width, p, opts, 0);
  if (opts.maxLines === undefined) return nodes;

  const cap = Math.max(1, opts.maxLines);
  const kept: ViewNode[] = [];
  let used = 0;
  for (const node of nodes) {
    const h = nodeLines(node);
    if (used + h > cap) break;
    kept.push(node);
    used += h;
  }
  const dropped = heightOf(nodes) - used;
  if (dropped > 0) kept.push(text(`… ${dropped} more line${dropped === 1 ? "" : "s"}`, { dim: true }));
  return kept;
}

/** Every glyph a node draws, as one line of text. */
function nodeText(node: ViewNode): string[] {
  if (typeof node === "string") return [node];
  switch (node.kind) {
    case "text":
      return [node.text];
    case "spacer":
      return [""];
    case "row": {
      // A row is COLUMNS: flatten each child, pad it to its own width and zip
      // the rows together, so a quote's gutter and a list item's hanging indent
      // read here exactly as they draw on screen.
      const parts = node.children.map(nodeText);
      const gap = " ".repeat(node.opts.gap ?? 0);
      const widths = parts.map((p) => Math.max(0, ...p.map((l) => l.length)));
      const height = Math.max(0, ...parts.map((p) => p.length));
      return Array.from({ length: height }, (_, i) =>
        parts.map((p, c) => (p[i] ?? "").padEnd(widths[c]!)).join(gap).trimEnd(),
      );
    }
    case "col":
    case "box":
      return node.children.flatMap(nodeText);
    default:
      return [""];
  }
}

/**
 * The same render, flattened to plain text — for the places a node cannot go:
 * a `recordRow` cell, a dash card, a desktop notification, a test. Markdown in,
 * readable prose out, with none of the syntax and none of the escapes.
 */
export function markdownToText(md: string, opts: MarkdownOpts = {}): string {
  return renderMarkdown(md, opts)
    .flatMap(nodeText)
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
