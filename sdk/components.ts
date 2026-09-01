/**
 * Reusable components. Each is a pure function returning ViewNode(s) built from
 * the primitives in ./index.ts — the host needs no knowledge of them. Applets
 * import what they want; anyone can add more here without touching the host.
 *
 * Three families overlap enough to be worth naming, so a new applet reaches for
 * the right one instead of adding a fourth:
 *
 *   chrome    `box` is the ONLY primitive that draws a frame. `card` is a box
 *             with a title and padding (the dashboard unit); `modal` is a card
 *             centered on the line with a heavier border (it reads as floating,
 *             and `overlay` in the applet def is what actually floats it).
 *   rows      `list` is a compact cursor list (a marker and a label);
 *             `recordRow` is the full-width, column-aligned mail/database row
 *             with a selected state. Both mark rows clickable with `index`.
 *   levels    `bar` is the primitive; `progress` adds a trailing label, `gauge`
 *             makes that label a percentage, and `meter` is the whole labeled
 *             instrument row. `sparkText`/`sparkline` are the series version —
 *             one implementation, string or node.
 */
import { type ViewNode, type Color, text, row, box, bar, spacer } from "./index.ts";
import { theme } from "../core/config.ts";

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

/** A vertical list with a cursor marker on the selected row. Rows are clickable. */
export function list(
  items: string[],
  opts: { cursor?: number; color?: Color; marker?: string } = {},
): ViewNode[] {
  const marker = opts.marker ?? "▸";
  return items.map((item, i) =>
    text(`${i === opts.cursor ? marker : " "} ${item}`, {
      color: i === opts.cursor ? opts.color : undefined,
      dim: i !== opts.cursor,
      index: i,
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

/**
 * A labeled text field: a dim caption beside an `input` primitive. Pass the
 * same `labelWidth` to a stack of fields and their captions line up, so a form
 * is just a `col` of these.
 */
export function field(label: string, node: ViewNode, opts: { labelWidth?: number } = {}): ViewNode {
  return row([text(label.padEnd(opts.labelWidth ?? label.length), { dim: true }), node], {
    gap: 1,
    align: "center",
  });
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

/** The eight bar heights every sparkline in kona draws with. */
const SPARK_RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** The level a half-scale sample rounds to — where a flat series sits. */
const SPARK_MID = SPARK_RAMP[Math.round((SPARK_RAMP.length - 1) / 2)]!;

/** How a series is drawn as one line of block glyphs. */
export interface SparkOpts {
  /**
   * Target width in samples. Omit to draw every sample. A longer series is
   * fitted by `fit`; a shorter one is left alone.
   */
  width?: number;
  /**
   * bucket — average the series down to `width` (the whole shape, compressed).
   * tail   — keep the LAST `width` samples (the recent trend). The default.
   */
  fit?: "bucket" | "tail";
  /**
   * Pin the scale. Do that when several sparklines must be comparable;
   * otherwise each series is scaled to its own min/max.
   */
  min?: number;
  max?: number;
  /** Glyphs per sample — widen so labels can sit underneath at the same offsets. */
  cell?: number;
}

/**
 * A series as one line of block characters: "▁▃▂▅▇█". THE sparkline — the
 * ViewNode version below and every applet that draws a trend come through
 * here, so a trend line looks the same wherever it appears.
 *
 * Non-finite samples keep their column as a gap and are left out of the scale,
 * so a series with holes still lines up with its own axis. A flat series draws
 * a flat mid-line rather than a misleading full or empty bar.
 */
export function sparkText(values: number[], opts: SparkOpts = {}): string {
  const cell = Math.max(1, opts.cell ?? 1);
  const points = fitSeries(values, opts);
  const finite = points.filter((n) => Number.isFinite(n));
  if (!finite.length) return "";

  const min = opts.min ?? Math.min(...finite);
  const max = opts.max ?? Math.max(...finite);
  const span = max - min;
  return points
    .map((n) => {
      if (!Number.isFinite(n)) return " ".repeat(cell);
      // A flat series has no shape to show — draw it mid-height rather than
      // slamming every sample to the floor.
      if (span === 0) return SPARK_MID.repeat(cell);
      const i = Math.round(((n - min) / span) * (SPARK_RAMP.length - 1));
      return SPARK_RAMP[Math.min(SPARK_RAMP.length - 1, Math.max(0, i))]!.repeat(cell);
    })
    .join("");
}

/** Fit a series to `width`: the mean of each bucket, or the recent tail. */
function fitSeries(values: number[], { width, fit = "tail" }: SparkOpts): number[] {
  if (width === undefined) return values;
  if (width < 1) return [];
  if (values.length <= width) return values;
  if (fit === "tail") return values.slice(-width);
  return Array.from({ length: width }, (_, i) => {
    const start = Math.floor((i * values.length) / width);
    const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / width));
    const slice = values.slice(start, end).filter((n) => Number.isFinite(n));
    // A bucket with nothing finite in it is a hole, not a zero.
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : NaN;
  });
}

/**
 * The sparkline as a colorable ViewNode — an inline unicode bar chart for
 * trends that have to fit on a single line (a temperature curve, a price tape,
 * CPU load). Same drawing as sparkText(), which is also what you want inside a
 * recordRow cell where a node can't go.
 */
export function sparkline(
  values: number[],
  opts: SparkOpts & { color?: Color; dim?: boolean } = {},
): ViewNode {
  return text(sparkText(values, opts), { color: opts.color, dim: opts.dim });
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
 *
 * Pass `index` (the row's position in whatever list the applet's cursor indexes)
 * to make the row clickable: the host fires `nav.select` with that `{ index }`.
 */
export function recordRow(
  cols: RecordCol[],
  opts: { width: number; selected?: boolean; accent?: Color; color?: Color; index?: number },
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
  const t = theme();
  if (opts.selected) {
    return text(line, { color: t.bg, bg: opts.accent ?? t.accent, focus: true, index: opts.index });
  }
  return text(line, { color: opts.color, index: opts.index });
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

/**
 * A tab strip header: the active tab is a filled chip, the rest are dim. Purely
 * presentational — the applet owns which tab is active and what switches it
 * (a verb + keymap), so the same strip serves a keypress and an agent call.
 */
export function tabs(
  labels: string[],
  active: number,
  opts: { accent?: Color; color?: Color } = {},
): ViewNode {
  const accent = opts.accent ?? "#7aa2f7";
  return row(
    labels.map((label, i) =>
      i === active
        ? text(` ${label} `, { color: "#0b0b0b", bg: accent })
        : text(` ${label} `, { dim: true, color: opts.color }),
    ),
    { gap: 1 },
  );
}

export type ToastKind = "info" | "warn" | "error";

const TOAST_STYLE: Record<ToastKind, { icon: string; color: Color }> = {
  info: { icon: "ℹ", color: "#7aa2f7" },
  warn: { icon: "▲", color: "#f0b000" },
  error: { icon: "✖", color: "#ff5c57" },
};

/**
 * A transient banner for the top of a view — "saved", "rate limited", "auth
 * failed". A filled bar rather than a line of colored text, so it reads as a
 * notification and not as content. Pass `width` to pad it across the viewport.
 */
export function toast(message: string, kind: ToastKind = "info", opts: { width?: number } = {}): ViewNode {
  const { icon, color } = TOAST_STYLE[kind] ?? TOAST_STYLE.info;
  const line = ` ${icon}  ${message} `;
  return text(opts.width ? line.slice(0, opts.width).padEnd(opts.width) : line, {
    color: "#0b0b0b",
    bg: color,
  });
}

/**
 * A small bordered sub-panel with a title — the unit a dashboard is built from.
 * Wraps the `box` primitive so applets never have to reach for chrome details.
 */
export function card(
  title: string,
  children: ViewNode[],
  opts: { color?: Color; width?: number | `${number}%`; padding?: number; grow?: boolean } = {},
): ViewNode {
  return box(children, {
    title,
    borderColor: opts.color,
    padding: opts.padding ?? 1,
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.grow ? { grow: true } : {}),
  });
}

/**
 * A modal: a centered card that reads as sitting on top of the view — a
 * confirm prompt, a detail popover. The terminal has no z-axis, so "on top" is
 * conveyed by centering and a heavier double border; the applet is responsible
 * for rendering it INSTEAD of (or above) its body and for the key that dismisses
 * it. `footer` is the dim hint line inside the frame, e.g. "enter ok · esc cancel".
 */
export function modal(
  title: string,
  children: ViewNode[],
  opts: { color?: Color; width?: number | `${number}%`; footer?: string } = {},
): ViewNode {
  const body = opts.footer ? [...children, spacer(), text(opts.footer, { dim: true })] : children;
  return row(
    [
      box(body, {
        title,
        titleAlign: "center",
        borderStyle: "double",
        borderColor: opts.color ?? "#bb9af7",
        padding: 1,
        ...(opts.width !== undefined ? { width: opts.width } : {}),
      }),
    ],
    { justify: "center" },
  );
}

/**
 * A labeled gauge row: "CPU   ████░░░░  42%  8 cores". The cockpit primitive —
 * a fixed-width label, a bar, its percentage, and an optional dim note, all
 * column-aligned so a stack of them reads as one instrument panel.
 */
export function meter(
  label: string,
  value: number,
  opts: { width?: number; color?: Color; note?: string; labelWidth?: number } = {},
): ViewNode {
  const pct = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`.padStart(4);
  const cells: ViewNode[] = [
    text(label.padEnd(opts.labelWidth ?? 6), { dim: true }),
    bar(value, { width: opts.width, color: opts.color }),
    text(`  ${pct}`, { color: opts.color }),
  ];
  if (opts.note) cells.push(text(`  ${opts.note}`, { dim: true }));
  return row(cells, { align: "center" });
}

export { spacer };
