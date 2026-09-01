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

export { spacer };
