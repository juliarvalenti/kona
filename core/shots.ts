import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, type AppletPackage } from "./load.ts";
import { resetConfig, theme } from "./config.ts";
import { heroSnapshot, renderApplet, renderAppletStyled, type AppletSnapshot, type StyledFrame, type StyledSpan } from "../sdk/testing.ts";

/**
 * The applet gallery: every applet's hero fixture, rendered to an SVG of a
 * terminal window, and the README block that shows them.
 *
 * The README used to describe applets it never showed. It still doesn't list
 * them by hand — the gallery is GENERATED from the packages the loader finds
 * (#33's rule: adding an applet edits no shared file), from the same
 * `snapshots.ts` fixtures the test suite asserts on. So a shot cannot drift
 * into marketing fiction: it is a real frame of a real applet, and
 * `tests/shots.test.ts` fails the build when the committed images stop
 * matching a fresh render.
 *
 * Everything here is deterministic on purpose — one window size, one pinned
 * clock, one timezone, the default theme — because the images are committed
 * and a diff has to mean "the UI changed", never "it ran on a Tuesday".
 */

/** The window every applet is shot in. Uniform, so the gallery is a grid. */
export const WINDOW = { cols: 80, rows: 24 };

/** The instant the whole gallery is frozen at, so "2m ago" stays "2m ago". */
export const SHOT_EPOCH = Date.parse("2026-09-01T16:00:45Z");

/** Timezone a hero renders in unless its fixture pins another. */
export const SHOT_TZ = "UTC";

/** Where the images live, relative to the repo root. */
export const SHOTS_DIR = "docs/shots";

/** Markers in README.md between which the gallery is spliced. */
const START = "<!-- shots:start -->";
const END = "<!-- shots:end -->";

/** Type metrics. A cell is `CELL_W` x `CELL_H` at `FONT_SIZE`. */
const FONT_SIZE = 14;
const CELL_W = 8.4;
const CELL_H = 18;
const PAD = 14;
const BAR_H = 30;
const FONT = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace`;

/** One applet's portrait. */
export interface Shot {
  id: string;
  title: string;
  summary: string;
  /** The fixture that was shot, so a caller can say which frame this is. */
  fixture: string;
  /** Repo-relative path of the image. */
  path: string;
  svg: string;
}

/**
 * Shoot every applet that ships in this repo. Plugins are skipped: their
 * images have no business in this checkout's `docs/`.
 */
export async function renderShots(packages: AppletPackage[]): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const pkg of packages) {
    if (pkg.source !== "repo") continue;
    const hero = await heroOf(pkg);
    if (!hero) continue;
    shots.push({
      id: pkg.def.id,
      title: pkg.def.title,
      summary: pkg.def.summary ?? "",
      fixture: hero.name,
      path: `${SHOTS_DIR}/${pkg.def.id}.svg`,
      svg: await heroSvg(pkg, hero),
    });
  }
  return shots;
}

/** An applet's hero fixture, or undefined when it ships none. */
export async function heroOf(pkg: AppletPackage): Promise<AppletSnapshot | undefined> {
  const file = join(pkg.dir, "snapshots.ts");
  if (!existsSync(file)) return undefined;
  const snaps = ((await import(file)) as { default?: AppletSnapshot[] }).default ?? [];
  return heroSnapshot(snaps);
}

/**
 * Render one hero at the gallery's fixed size, with the clock, the timezone
 * and the theme all pinned — the drawing too, since the window chrome is
 * painted from the theme as well. The fixture's own `width`/`height` are
 * ignored on purpose: a gallery of differently-sized windows is a mess, and an
 * applet that only looks right at its own size is worth knowing about.
 */
export async function heroSvg(pkg: AppletPackage, hero: AppletSnapshot): Promise<string> {
  const def = pkg.def;
  return pinned(hero.tz ?? SHOT_TZ, async () => {
    const state = typeof hero.state === "function" ? hero.state() : hero.state;
    return toSvg(await renderAppletStyled(def, state, WINDOW.cols, WINDOW.rows), def.title);
  });
}

/**
 * The same frame as plain text — "show me what you look like", with no live
 * data, no account and no TTY. `bun run bin/snapshot.ts <applet> --hero`.
 */
export async function heroText(pkg: AppletPackage, hero: AppletSnapshot): Promise<string> {
  const def = pkg.def;
  return pinned(hero.tz ?? SHOT_TZ, async () => {
    const state = typeof hero.state === "function" ? hero.state() : hero.state;
    return renderApplet(def, state, WINDOW.cols, WINDOW.rows);
  });
}

/**
 * Run `fn` at `SHOT_EPOCH`, in `tz`, against the default theme. Applets read
 * the wall clock freely (`ago()`, countdowns) and the theme comes from the
 * developer's own config.toml — neither may leak into a committed image.
 */
export async function pinned<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const oldTz = process.env.TZ;
  const oldCfg = process.env.KONA_CONFIG_DIR;
  const oldPlugins = process.env.KONA_NO_PLUGINS;
  Date.now = () => SHOT_EPOCH;
  process.env.TZ = tz;
  process.env.KONA_CONFIG_DIR = join(REPO_ROOT, ".kona-no-such-config");
  process.env.KONA_NO_PLUGINS = "1";
  resetConfig();
  try {
    return await fn();
  } finally {
    Date.now = realNow;
    restore("TZ", oldTz);
    restore("KONA_CONFIG_DIR", oldCfg);
    restore("KONA_NO_PLUGINS", oldPlugins);
    resetConfig();
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// --- the drawing -----------------------------------------------------------

/**
 * A captured frame as an SVG of a terminal window — chrome, background fills,
 * and one `<text>` per styled run. Positions are absolute (column x cell
 * width) and every run declares its `textLength`, so the image lines up in
 * whatever monospace font the reader's machine picks.
 */
export function toSvg(frame: StyledFrame, title: string): string {
  const t = theme();
  const w = round(frame.cols * CELL_W + PAD * 2);
  const h = round(frame.rows * CELL_H + PAD + BAR_H);
  const body: string[] = [
    `<rect width="${w}" height="${h}" rx="10" fill="${t.bg}"/>`,
    `<rect x="0.5" y="0.5" width="${round(w - 1)}" height="${round(h - 1)}" rx="9.5" fill="none" stroke="${t.muted}" stroke-opacity="0.35"/>`,
    // Window chrome: three dots and the applet's title, so a shot reads as a
    // window rather than a stray block of text.
    ...[
      ["#ff5f56", 20],
      ["#ffbd2e", 36],
      ["#27c93f", 52],
    ].map(([fill, cx]) => `<circle cx="${cx}" cy="${BAR_H / 2}" r="5" fill="${fill}"/>`),
    `<text x="${round(w / 2)}" y="${BAR_H / 2 + 4}" fill="${t.dim}" font-size="12" text-anchor="middle">${esc(title)}</text>`,
  ];

  frame.lines.slice(0, frame.rows).forEach((spans, rowIndex) => {
    const y = BAR_H + rowIndex * CELL_H;
    let col = 0;
    for (const span of spans) {
      const x = round(PAD + col * CELL_W);
      if (span.bg) {
        body.push(`<rect x="${x}" y="${round(y)}" width="${round(span.width * CELL_W)}" height="${CELL_H}" fill="${span.bg}"/>`);
      }
      for (const piece of pieces(span)) {
        const px = round(PAD + (col + piece.col) * CELL_W);
        const width = round(piece.width * CELL_W);
        if (piece.block) body.push(...drawn(piece.text, span, px, y));
        else if (piece.text.trim()) body.push(run(piece.text, span, px, round(y + CELL_H - 5), width));
      }
      col += span.width;
    }
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" font-size="${FONT_SIZE}">`,
    `<title>${esc(title)}</title>`,
    ...body,
    `</svg>`,
    ``,
  ].join("\n");
}

/** One styled run of cells. */
function run(text: string, span: StyledSpan, x: number, y: number, width: number): string {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `fill="${span.fg}"`,
    // Absolute width, stretched to fit: box-drawing runs stay joined even if
    // the reader's monospace font has a different advance than ours.
    `textLength="${width}"`,
    `lengthAdjust="spacingAndGlyphs"`,
    `xml:space="preserve"`,
    ...(span.bold ? [`font-weight="bold"`] : []),
    ...(span.italic ? [`font-style="italic"`] : []),
    ...(span.underline ? [`text-decoration="underline"`] : []),
    ...(span.dim ? [`opacity="0.65"`] : []),
  ];
  return `<text ${attrs.join(" ")}>${esc(text)}</text>`;
}

/**
 * The block-drawing glyphs, as the fraction of the cell they fill:
 * `[x, y, w, h]` in cell units, plus an alpha for the shades. kona's gauges,
 * progress bars, sparklines and big clock font are made of these, and a font's
 * idea of where the ink stops leaves hairlines between adjacent cells — the
 * seams you see in a terminal that doesn't special-case them. Drawing them as
 * rectangles instead is what a good terminal does, and it makes the gallery
 * independent of whatever monospace font the reader happens to have.
 */
const BLOCK: Record<string, [number, number, number, number, number?]> = {
  "\u2588": [0, 0, 1, 1], // █ full
  "\u2580": [0, 0, 1, 0.5], // ▀ upper half
  "\u2584": [0, 0.5, 1, 0.5], // ▄ lower half
  "\u2590": [0.5, 0, 0.5, 1], // ▐ right half
  "\u2591": [0, 0, 1, 1, 0.25], // ░ light shade
  "\u2592": [0, 0, 1, 1, 0.5], // ▒ medium shade
  "\u2593": [0, 0, 1, 1, 0.75], // ▓ dark shade
  // ▁▂▃▄▅▆▇ — eighths growing up from the floor (sparklines, gauges).
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [
      String.fromCharCode(0x2580 + n),
      [0, 1 - n / 8, 1, n / 8] as [number, number, number, number],
    ]),
  ),
  // ▏▎▍▌▋▊▉ — eighths growing right from the wall (progress bars).
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [
      String.fromCharCode(0x2590 - n),
      [0, 0, n / 8, 1] as [number, number, number, number],
    ]),
  ),
};

/**
 * The single-line box-drawing glyphs, as which way they reach out of the
 * centre of their cell. Every applet is inside a frame and most draw dividers,
 * and a font's `\u2502` is a glyph a little shorter than the line box — so a
 * frame typeset as text comes out dashed. Stroked from edge to edge instead,
 * neighbouring cells meet exactly and the frame is a frame.
 */
const LINE: Record<string, { l?: 1; r?: 1; u?: 1; d?: 1; round?: 1 }> = {
  "\u2500": { l: 1, r: 1 }, // ─
  "\u2502": { u: 1, d: 1 }, // │
  "\u250c": { r: 1, d: 1 }, // ┌
  "\u2510": { l: 1, d: 1 }, // ┐
  "\u2514": { r: 1, u: 1 }, // └
  "\u2518": { l: 1, u: 1 }, // ┘
  "\u251c": { u: 1, d: 1, r: 1 }, // ├
  "\u2524": { u: 1, d: 1, l: 1 }, // ┤
  "\u252c": { l: 1, r: 1, d: 1 }, // ┬
  "\u2534": { l: 1, r: 1, u: 1 }, // ┴
  "\u253c": { l: 1, r: 1, u: 1, d: 1 }, // ┼
  "\u256d": { r: 1, d: 1, round: 1 }, // ╭
  "\u256e": { l: 1, d: 1, round: 1 }, // ╮
  "\u256f": { l: 1, u: 1, round: 1 }, // ╯
  "\u2570": { r: 1, u: 1, round: 1 }, // ╰
};

/** Half the stroke a box line is drawn with. */
const HAIR = 0.6;

/** A slice of a span: either glyphs we draw ourselves, or text to typeset. */
interface Piece {
  text: string;
  /** Columns from the start of the span. */
  col: number;
  width: number;
  block: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Split a span into block runs and text runs. When the per-glyph widths don't
 * add up to the width the renderer reported (an exotic grapheme), the span is
 * left whole and typeset as text — the layout stays right, which matters more
 * than a crisp bar.
 */
function pieces(span: StyledSpan): Piece[] {
  const cells = [...graphemes.segment(span.text)].map((g) => ({
    text: g.segment,
    width: Bun.stringWidth(g.segment),
  }));
  const total = cells.reduce((n, c) => n + c.width, 0);
  if (total !== span.width || !cells.some((c) => drawable(c.text))) {
    return [{ text: span.text, col: 0, width: span.width, block: false }];
  }
  const out: Piece[] = [];
  let col = 0;
  for (const cell of cells) {
    const block = drawable(cell.text);
    const last = out[out.length - 1];
    if (last && last.block === block) {
      last.text += cell.text;
      last.width += cell.width;
    } else {
      out.push({ text: cell.text, col, width: cell.width, block });
    }
    col += cell.width;
  }
  return out;
}

/** Glyphs kona draws itself rather than typesetting. */
const drawable = (ch: string): boolean => !!BLOCK[ch] || !!LINE[ch];

/** A run of them, drawn — merged while the shape repeats. */
function drawn(text: string, span: StyledSpan, x: number, y: number): string[] {
  const out: string[] = [];
  const cells = [...text];
  for (let i = 0; i < cells.length; ) {
    const ch = cells[i]!;
    let n = 1;
    while (cells[i + n] === ch) n++;
    const at = round(x + i * CELL_W);
    out.push(...(LINE[ch] ? [line(ch, span, at, y, n)] : fills(ch, span, at, y, n)));
    i += n;
  }
  return out;
}

/** One box-drawing cell (or a run of identical ones), stroked edge to edge. */
function line(ch: string, span: StyledSpan, x: number, y: number, n: number): string {
  const { l, r, u, d, round: rounded } = LINE[ch]!;
  const cx = x + CELL_W / 2;
  const cy = y + CELL_H / 2;
  const right = x + n * CELL_W;
  const bottom = y + CELL_H;
  const parts: string[] = [];
  // A run of `─` is one long segment; anything else repeats per cell, and a
  // straight run through the cell is drawn in one stroke so nothing shows a
  // join in the middle.
  if (l && r) parts.push(`M${round(x)} ${round(cy)}H${round(right)}`);
  else if (l) parts.push(`M${round(x)} ${round(cy)}H${round(cx - (rounded ? HAIR * 3 : 0))}`);
  else if (r) parts.push(`M${round(right)} ${round(cy)}H${round(cx + (rounded ? HAIR * 3 : 0))}`);
  if (u && d) parts.push(`M${round(cx)} ${round(y)}V${round(bottom)}`);
  else if (u) parts.push(`M${round(cx)} ${round(y)}V${round(cy - (rounded ? HAIR * 3 : 0))}`);
  else if (d) parts.push(`M${round(cx)} ${round(bottom)}V${round(cy + (rounded ? HAIR * 3 : 0))}`);
  // The rounded corners get their elbow back as a quarter arc.
  if (rounded) {
    const hx = round(cx + (r ? HAIR * 3 : -HAIR * 3));
    const vy = round(cy + (d ? HAIR * 3 : -HAIR * 3));
    parts.push(`M${hx} ${round(cy)}Q${round(cx)} ${round(cy)} ${round(cx)} ${vy}`);
  }
  const dim = span.dim ? ` opacity="0.65"` : "";
  return `<path d="${parts.join("")}" stroke="${span.fg}" stroke-width="${HAIR * 2}" fill="none"${dim}/>`;
}

/** A run of block glyphs, as rectangles. */
function fills(ch: string, span: StyledSpan, x: number, y: number, n: number): string[] {
  const [bx, by, bw, bh, alpha] = BLOCK[ch]!;
  const opacity = (alpha ?? 1) * (span.dim ? 0.65 : 1);
  const fade = opacity < 1 ? ` opacity="${round(opacity)}"` : "";
  const rect = (i: number, cells: number) =>
    `<rect x="${round(x + (i + bx) * CELL_W)}" y="${round(y + by * CELL_H)}" ` +
    `width="${round((bw + cells - 1) * CELL_W)}" height="${round(bh * CELL_H)}" fill="${span.fg}"${fade}/>`;
  // Neighbouring cells merge into one rectangle only when the shape spans the
  // full width of its cell; a run of eighths is a run of separate bars.
  if (bx === 0 && bw === 1) return [rect(0, n)];
  return Array.from({ length: n }, (_, i) => rect(i, 1));
}

const round = (n: number): number => Math.round(n * 100) / 100;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- the README block ------------------------------------------------------

/** How many shots per row in the gallery. */
const COLUMNS = 2;

/**
 * The gallery, as an HTML table so the images can be sized. Generated from the
 * shots, which came from the packages — there is no hand-kept list to fall out
 * of date when someone adds an applet.
 */
export function galleryMarkdown(shots: Shot[]): string {
  const cells = shots.map((s) => {
    const docs = existsSync(join(REPO_ROOT, "applets", s.id, "README.md"))
      ? `<a href="applets/${s.id}/README.md"><code>${s.id}</code></a>`
      : `<code>${s.id}</code>`;
    return [
      `<td width="50%" valign="top">`,
      `<img src="${s.path}" width="100%" alt="${escAttr(`${s.title} — ${s.fixture}`)}">`,
      `<br><sub>${docs} — ${esc(s.summary)}</sub>`,
      `</td>`,
    ].join("\n");
  });

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += COLUMNS) {
    rows.push(`<tr>`, ...cells.slice(i, i + COLUMNS), `</tr>`);
  }
  return [
    START,
    `<!-- generated by \`bun run shots\` from each applet's hero fixture — do not edit by hand -->`,
    `<table>`,
    ...rows,
    `</table>`,
    END,
  ].join("\n");
}

/** Put a freshly generated gallery between the README's markers. */
export function spliceGallery(readme: string, gallery: string): string {
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`README.md is missing the ${START} / ${END} markers the gallery goes between`);
  }
  return readme.slice(0, from) + gallery + readme.slice(to + END.length);
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}
