/**
 * Reusable components. Each is a pure function returning ViewNode(s) built from
 * the primitives in ./index.ts — the host needs no knowledge of them. Applets
 * import what they want; anyone can add more here without touching the host.
 */
import { type ViewNode, type Color, text, row, bar, spacer } from "./index.ts";

/** A progress bar with an optional trailing label, e.g. "▓▓▓░░ 60%". */
export function progress(
  value: number,
  opts: { width?: number; color?: Color; label?: string } = {},
): ViewNode {
  const b = bar(value, { width: opts.width, color: opts.color });
  if (!opts.label) return b;
  return row([b, text(`  ${opts.label}`, { dim: true })]);
}

/** A dim key and a value on one line: "label   value". */
export function keyValue(key: string, value: string, opts: { color?: Color } = {}): ViewNode {
  return row([text(`${key} `, { dim: true }), text(value, { color: opts.color })]);
}

/** A vertical list with a cursor marker on the selected row. */
export function list(
  items: string[],
  opts: { cursor?: number; color?: Color; marker?: string } = {},
): ViewNode[] {
  const marker = opts.marker ?? "▸";
  return items.map((item, i) =>
    text(`${i === opts.cursor ? marker : " "} ${item}`, {
      color: i === opts.cursor ? opts.color : undefined,
      dim: i !== opts.cursor,
    }),
  );
}

/** A small colored chip, e.g. a status badge. */
export function badge(label: string, color: Color): ViewNode {
  return text(`[${label}]`, { color });
}

/** A progress bar that labels itself with a percentage. */
export function gauge(value: number, opts: { width?: number; color?: Color } = {}): ViewNode {
  return progress(value, { ...opts, label: `${Math.round(value * 100)}%` });
}

/** A horizontal rule. */
export function divider(width = 32, opts: { color?: Color } = {}): ViewNode {
  return text("─".repeat(width), { color: opts.color, dim: !opts.color });
}

/** A section heading. */
export function heading(label: string, color?: Color): ViewNode {
  return text(label, { color, dim: !color });
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An animated spinner. `frame` is any monotonically increasing counter. */
export function spinner(frame: number, color?: Color): ViewNode {
  const i = ((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  return text(SPINNER_FRAMES[i]!, { color });
}

export interface RecordCol {
  text: string;
  /** Fixed column width in chars. Omit + grow:true to fill remaining space. */
  width?: number;
  grow?: boolean;
  align?: "left" | "right";
}

/**
 * A "record row" — a database/mail-client style row of aligned columns that
 * spans the full width, with a first-class selected state (full-width accent
 * bar + scroll focus). Fixed columns take their width; grow columns split the
 * rest. This is the reusable list-row aesthetic.
 */
export function recordRow(
  cols: RecordCol[],
  opts: { width: number; selected?: boolean; accent?: Color; color?: Color },
): ViewNode {
  const GAP = 2;
  const gaps = Math.max(0, cols.length - 1) * GAP;
  const fixed = cols.reduce((s, c) => s + (c.grow ? 0 : (c.width ?? c.text.length)), 0);
  const growCols = cols.filter((c) => c.grow).length;
  const rest = Math.max(0, opts.width - 2 - fixed - gaps); // -2 for the gutter
  const growW = growCols ? Math.floor(rest / growCols) : 0;

  const cell = (c: RecordCol) => {
    const w = c.grow ? growW : (c.width ?? c.text.length);
    const t = c.text.length > w ? c.text.slice(0, Math.max(0, w - 1)) + "…" : c.text;
    return c.align === "right" ? t.padStart(w) : t.padEnd(w);
  };

  const line = ("  " + cols.map(cell).join(" ".repeat(GAP))).slice(0, opts.width).padEnd(opts.width);
  if (opts.selected) {
    return text(line, { color: "#0b0b0b", bg: opts.accent ?? "#7aa2f7", focus: true });
  }
  return text(line, { color: opts.color });
}

/** A column-aligned table: dim header row + body rows. */
export function table(headers: string[], rows: string[][], opts: { color?: Color } = {}): ViewNode[] {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const fmtRow = (cells: string[]) => cells.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ");
  return [
    text(fmtRow(headers), { dim: true }),
    ...rows.map((r) => text(fmtRow(r), { color: opts.color })),
  ];
}

export { spacer };
