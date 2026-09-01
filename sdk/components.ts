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
  return row(b, text(`  ${opts.label}`, { dim: true }));
}

/** A dim key and a value on one line: "label   value". */
export function keyValue(key: string, value: string, opts: { color?: Color } = {}): ViewNode {
  return row(text(`${key} `, { dim: true }), text(value, { color: opts.color }));
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
