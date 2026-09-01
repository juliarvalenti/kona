/**
 * The line editor — a pure (value, cursor) machine.
 *
 * Every place kona takes typed text goes through here: the `/` search line in
 * the footer and every `input` node an applet puts in its view tree. One brain,
 * so a text field behaves identically wherever it appears, and the behaviour is
 * testable without a terminal (no TTY, no renderer, no daemon).
 *
 * It is deliberately dumb about *where* the text ends up. The host decides that
 * — fire a verb, filter a list — which keeps this file free of any I/O.
 *
 * It has two shapes, chosen per keypress by the caller (`EditOpts.multiline`):
 * a one-line field, where enter submits, and a textarea, where enter is a
 * newline and ctrl+d submits. Everything else — the readline bindings, the
 * cursor arithmetic — is shared, so a note body and a search box are the same
 * brain with a different exit key.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** A cursored text buffer. `cursor` is an index into `value` (0..length). */
export interface Edit {
  value: string;
  cursor: number;
}

/** The subset of a terminal keypress the editor cares about. */
export interface KeyEvent {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/**
 * What the keypress meant:
 *   edit   — the buffer moved (or tried to); keep editing
 *   submit — enter: hand the value off
 *   cancel — esc: abandon the edit
 *   ignore — not ours; let the host do something else with the key
 */
export type EditAction = "edit" | "submit" | "cancel" | "ignore";

/** Build a buffer, clamping the cursor (defaults to the end of the text). */
export const edit = (value = "", cursor = value.length): Edit => ({
  value,
  cursor: clamp(cursor, 0, value.length),
});

/**
 * True for text we can insert: no escape sequences, no control characters. A
 * textarea makes ONE exception — a pasted blob keeps its newlines, because
 * pasting a paragraph into a note body is the point of having one.
 */
function printable(seq: string, multiline = false): boolean {
  if (!seq || seq.startsWith("\x1b")) return false;
  return [...seq].every((c) => (c >= " " || (multiline && c === "\n")) && c !== "\x7f");
}

/** How the buffer behaves. Multi-line turns enter into a newline. */
export interface EditOpts {
  /**
   * Textarea mode: enter inserts a newline, ctrl+d submits, ↑/↓ walk lines and
   * the line-wise bindings (home/end, ctrl+a/e/u/k) act on the CURRENT line
   * rather than the whole buffer.
   */
  multiline?: boolean;
}

/** Index of the first character of the line the cursor sits on. */
const lineStart = (value: string, cursor: number) => value.lastIndexOf("\n", cursor - 1) + 1;

/** Index one past the last character of the cursor's line (the \n, or the end). */
function lineEnd(value: string, cursor: number): number {
  const nl = value.indexOf("\n", cursor);
  return nl === -1 ? value.length : nl;
}

/**
 * Move one line up or down, keeping the column. Clamps at the first and last
 * line — a textarea's ↑ at the top does nothing rather than escaping the field.
 */
function moveLine(value: string, cursor: number, dir: -1 | 1): number {
  const start = lineStart(value, cursor);
  const col = cursor - start;
  if (dir === -1) {
    if (start === 0) return cursor;
    const prevStart = lineStart(value, start - 1);
    return Math.min(prevStart + col, start - 1);
  }
  const end = lineEnd(value, cursor);
  if (end === value.length) return cursor;
  const nextEnd = lineEnd(value, end + 1);
  return Math.min(end + 1 + col, nextEnd);
}

/**
 * Apply one keypress to a buffer. Returns the next buffer and what the key
 * meant. Readline-ish bindings, because that is what fingers expect:
 *
 *   ←/→ home/end          move          ctrl+a / ctrl+e   line start / end
 *   backspace / delete    erase         ctrl+w            erase word back
 *   ctrl+u / ctrl+k       kill to start / end of line
 *   enter submit          esc cancel
 *
 * In `multiline` mode enter is a NEWLINE and ctrl+d submits (ctrl+s too, for
 * the fingers that reach for save) — a note body has to be able to contain the
 * key that would otherwise end the edit. ↑/↓ then move between lines, and the
 * line-wise bindings act on the cursor's line instead of the whole buffer.
 */
export function applyKey(buf: Edit, k: KeyEvent, opts: EditOpts = {}): { edit: Edit; action: EditAction } {
  const { value, cursor } = buf;
  const multi = !!opts.multiline;
  const moved = (v: string, c: number) => ({ edit: edit(v, c), action: "edit" as const });
  const same = (action: EditAction) => ({ edit: buf, action });
  // Where "the line" starts and ends: the whole buffer for a one-line field,
  // the cursor's own line in a textarea.
  const from = multi ? lineStart(value, cursor) : 0;
  const to = multi ? lineEnd(value, cursor) : value.length;

  if (k.name === "return" || k.name === "enter") {
    if (!multi) return same("submit");
    return moved(value.slice(0, cursor) + "\n" + value.slice(cursor), cursor + 1);
  }
  if (k.name === "escape") return same("cancel");

  if (k.ctrl) {
    switch (k.name) {
      case "a":
        return moved(value, from);
      case "e":
        return moved(value, to);
      case "u":
        return moved(value.slice(0, from) + value.slice(cursor), from);
      case "k":
        return moved(value.slice(0, cursor) + value.slice(to), cursor);
      case "w": {
        const head = value.slice(0, cursor).replace(/[^\S\n]*\S*$/, "");
        return moved(head + value.slice(cursor), head.length);
      }
      case "d":
      case "s":
        // The textarea's exit key. A one-line field has enter for this, so
        // these stay the host's business there (ctrl+d must not eat a keybind).
        return same(multi ? "submit" : "ignore");
      default:
        return same("ignore"); // ctrl+c and friends stay the host's business
    }
  }

  switch (k.name) {
    case "backspace":
      return moved(value.slice(0, Math.max(0, cursor - 1)) + value.slice(cursor), cursor - 1);
    case "delete":
      return moved(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
    case "left":
      return moved(value, cursor - 1);
    case "right":
      return moved(value, cursor + 1);
    case "up":
      if (multi) return moved(value, moveLine(value, cursor, -1));
      break;
    case "down":
      if (multi) return moved(value, moveLine(value, cursor, 1));
      break;
    case "home":
      return moved(value, from);
    case "end":
      return moved(value, to);
  }

  const seq = k.sequence;
  if (seq && !k.meta && printable(seq, multi)) {
    return moved(value.slice(0, cursor) + seq + value.slice(cursor), cursor + seq.length);
  }
  return same("ignore");
}

/**
 * The slice of a buffer visible in a field `width` cells wide, with the cursor
 * re-based into it — so text longer than the field scrolls horizontally under
 * the caret instead of overflowing the layout. The caret needs a cell of its
 * own, hence the window ends one past the last character.
 */
export function windowOf(buf: Edit, width: number): { text: string; cursor: number } {
  const w = Math.max(1, width);
  const start = Math.max(0, buf.cursor - w + 1);
  return { text: buf.value.slice(start, start + w), cursor: buf.cursor - start };
}

/** One wrapped display line: its text, and where it starts in the buffer. */
interface Segment {
  text: string;
  /** Index in `value` of this line's first character. */
  start: number;
}

/**
 * Wrap one logical line to `width`, breaking after a space when there is one.
 * Segments partition the line exactly — no character is dropped and none is
 * added — which is what lets a buffer index map back to a (row, col) below.
 */
function wrapLine(line: string, start: number, width: number): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  while (pos < line.length) {
    if (line.length - pos <= width) break;
    const space = line.lastIndexOf(" ", pos + width - 1);
    const cut = space > pos ? space + 1 - pos : width;
    out.push({ text: line.slice(pos, pos + cut), start: start + pos });
    pos += cut;
  }
  out.push({ text: line.slice(pos), start: start + pos });
  return out;
}

/** A textarea's visible window: the lines to draw and where the caret sits. */
export interface EditFrame {
  /** The `height` (or fewer) display lines currently on screen. */
  lines: string[];
  /** Caret position within `lines` — row is already rebased into the window. */
  cursor: { row: number; col: number };
  /** Index of the first visible display line, and how many there are in all. */
  top: number;
  total: number;
}

/**
 * The multi-line counterpart of `windowOf`: hard newlines split, long lines
 * word-wrap to `width`, and the window scrolls VERTICALLY to keep the caret in
 * view. Pure, so a textarea's scrolling is testable without a renderer.
 */
export function frameOf(buf: Edit, width: number, height: number): EditFrame {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const segments: Segment[] = [];
  let at = 0;
  for (const line of buf.value.split("\n")) {
    segments.push(...wrapLine(line, at, w));
    at += line.length + 1; // the \n the split consumed
  }

  // The caret's row is the last segment that starts at or before it — so a
  // cursor sitting on a wrap boundary lands at the head of the next line.
  let row = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.start <= buf.cursor) row = i;
  }
  const col = buf.cursor - segments[row]!.start;

  const top = clamp(row - h + 1, 0, Math.max(0, segments.length - h));
  return {
    lines: segments.slice(top, top + h).map((s) => s.text),
    cursor: { row: row - top, col },
    top,
    total: segments.length,
  };
}
