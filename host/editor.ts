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

/** True for text we can insert: no escape sequences, no control characters. */
function printable(seq: string): boolean {
  if (!seq || seq.startsWith("\x1b")) return false;
  return [...seq].every((c) => c >= " " && c !== "\x7f");
}

/**
 * Apply one keypress to a buffer. Returns the next buffer and what the key
 * meant. Readline-ish bindings, because that is what fingers expect:
 *
 *   ←/→ home/end          move          ctrl+a / ctrl+e   line start / end
 *   backspace / delete    erase         ctrl+w            erase word back
 *   ctrl+u / ctrl+k       kill to start / end of line
 *   enter submit          esc cancel
 */
export function applyKey(buf: Edit, k: KeyEvent): { edit: Edit; action: EditAction } {
  const { value, cursor } = buf;
  const moved = (v: string, c: number) => ({ edit: edit(v, c), action: "edit" as const });
  const same = (action: EditAction) => ({ edit: buf, action });

  if (k.name === "return" || k.name === "enter") return same("submit");
  if (k.name === "escape") return same("cancel");

  if (k.ctrl) {
    switch (k.name) {
      case "a":
        return moved(value, 0);
      case "e":
        return moved(value, value.length);
      case "u":
        return moved(value.slice(cursor), 0);
      case "k":
        return moved(value.slice(0, cursor), cursor);
      case "w": {
        const head = value.slice(0, cursor).replace(/\s*\S*$/, "");
        return moved(head + value.slice(cursor), head.length);
      }
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
    case "home":
      return moved(value, 0);
    case "end":
      return moved(value, value.length);
  }

  const seq = k.sequence;
  if (seq && !k.meta && printable(seq)) {
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
