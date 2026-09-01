import { bg, bold, fg, type TextChunk } from "@opentui/core";
import type { Color, InputNode } from "../sdk/index.ts";
import { type Edit, edit as mkEdit, frameOf, windowOf } from "./editor.ts";
import { fieldRows } from "./nodes.ts";

/**
 * Text fields, as styled cells.
 *
 * An `input` node is the one view primitive with a caret, and OpenTUI paints
 * through its own buffer — there is no real terminal cursor to move — so the
 * caret is drawn as an inverted cell inside a padded trough. Keeping that here
 * means the stage only has to hand the chunks to a TextRenderable.
 */

/** The keystrokes a focused field has taken but not yet submitted. */
export interface Draft {
  id: string;
  edit: Edit;
}

/** The theme roles a field paints with. */
export interface FieldColors {
  fg: Color;
  dim: Color;
  field: Color;
  fieldFocus: Color;
  caret: Color;
  caretFg: Color;
}

/**
 * A text field as styled cells: a padded trough so the highlight spans the
 * whole field, with the caret drawn as an inverted cell inside it. `draft` is
 * the host's in-flight buffer; it wins over the value in state while the field
 * it belongs to has the keyboard.
 */
export function inputChunks(node: InputNode, draft: Draft | null, c: FieldColors): TextChunk[] {
  const width = Math.max(1, node.width ?? 32);
  const live = node.focus && draft?.id === node.id ? draft.edit : mkEdit(node.value);
  const buf: Edit = node.mask ? mkEdit("•".repeat(live.value.length), live.cursor) : live;
  const trough = node.focus ? c.fieldFocus : c.field;
  const ink = node.color ?? c.fg;
  const paint = (t: string) => fg(ink)(bg(trough)(t));
  const hint = (t: string) => fg(c.dim)(bg(trough)(t));

  if (!node.focus) {
    const empty = buf.value.length === 0;
    const shown = empty ? (node.placeholder ?? "") : buf.value;
    const body = (shown.length > width ? shown.slice(0, width - 1) + "…" : shown).padEnd(width);
    return [empty ? hint(body) : paint(body)];
  }

  const win = windowOf(buf, width);
  const line = win.text.padEnd(width);
  const caret = fg(c.caretFg)(bg(c.caret)(line.slice(win.cursor, win.cursor + 1) || " "));
  // An empty focused field still advertises what it wants, to the caret's right.
  const tail =
    buf.value.length === 0 && node.placeholder
      ? hint(node.placeholder.slice(0, width - 1).padEnd(width - 1))
      : paint(line.slice(win.cursor + 1));
  return [paint(line.slice(0, win.cursor)), caret, tail].filter((chunk) => chunk.text.length > 0);
}

/**
 * A textarea as rows of styled cells. The text wraps one column narrower than
 * the field so the caret always has a cell to sit in past the last character,
 * and the block keeps its full height even when empty — a field that grows and
 * shrinks under your fingers is worse than one that reserves its space.
 */
export function inputLines(node: InputNode, draft: Draft | null, c: FieldColors): TextChunk[][] {
  const width = Math.max(2, node.width ?? 32);
  const rows = fieldRows(node);
  // Unfocused, the window starts at the top: you read a note from its first
  // line, not from wherever the caret was left. Focused with nothing typed
  // yet, the caret sits at the end — where the host's first keystroke will
  // put it, so it never jumps as you start typing.
  const live =
    draft?.id === node.id && node.focus ? draft.edit : mkEdit(node.value, node.focus ? undefined : 0);
  const trough = node.focus ? c.fieldFocus : c.field;
  const ink = node.color ?? c.fg;
  const paint = (t: string) => fg(ink)(bg(trough)(t));
  const blank = (): TextChunk[] => [paint(" ".repeat(width))];

  // An empty field advertises what it wants — beside the caret when focused,
  // in its place when not.
  if (!live.value.length && node.placeholder) {
    const room = node.focus ? width - 1 : width;
    const ph = node.placeholder.slice(0, room).padEnd(room);
    const first: TextChunk[] = node.focus
      ? [fg(c.caretFg)(bg(c.caret)(" ")), fg(c.dim)(bg(trough)(ph))]
      : [fg(c.dim)(bg(trough)(ph))];
    return [first, ...Array.from({ length: rows - 1 }, blank)];
  }

  const win = frameOf(live, width - 1, rows);
  const out = win.lines.map((line, r): TextChunk[] => {
    const padded = line.slice(0, width).padEnd(width);
    if (!node.focus || r !== win.cursor.row) return [paint(padded)];
    const col = win.cursor.col;
    return [
      paint(padded.slice(0, col)),
      fg(c.caretFg)(bg(c.caret)(padded.slice(col, col + 1) || " ")),
      paint(padded.slice(col + 1)),
    ].filter((chunk) => chunk.text.length > 0);
  });
  while (out.length < rows) out.push(blank());
  return out;
}

/**
 * The `/` search line: the same caret-in-the-text treatment as an `input` node,
 * so the footer editor and a field in the view tree feel like one widget.
 */
export function searchChunks(
  buf: Edit,
  placeholder: string | undefined,
  c: Pick<FieldColors, "fg" | "dim" | "caret" | "caretFg"> & { accent: Color },
  opts: { label?: string; hint?: string } = {},
): TextChunk[] {
  const chunks: TextChunk[] = [fg(c.accent)(bold(`${opts.label ?? "search"} `))];
  if (buf.value.length === 0) {
    chunks.push(fg(c.caret)("█"), fg(c.dim)(placeholder ?? ""));
  } else {
    const at = buf.value.slice(buf.cursor, buf.cursor + 1);
    chunks.push(
      fg(c.fg)(buf.value.slice(0, buf.cursor)),
      at ? fg(c.caretFg)(bg(c.caret)(at)) : fg(c.caret)("█"),
      fg(c.fg)(buf.value.slice(buf.cursor + 1)),
    );
  }
  chunks.push(fg(c.dim)(`    ${opts.hint ?? "enter apply · esc cancel"}`));
  return chunks.filter((chunk) => chunk.text.length > 0);
}
