import { test, expect } from "bun:test";
import { applyKey, edit, frameOf, windowOf, type Edit, type KeyEvent } from "../host/editor.ts";

/**
 * The line editor is the whole interaction model of a text field, so it is
 * tested where it lives: as pure data, no terminal, no daemon.
 */

/** Type a string one keypress at a time, as the terminal would deliver it. */
function type(buf: Edit, s: string): Edit {
  return [...s].reduce((b, ch) => applyKey(b, { name: ch, sequence: ch }).edit, buf);
}
const press = (buf: Edit, k: KeyEvent) => applyKey(buf, k);

test("typing inserts at the cursor and carries it along", () => {
  const b = type(edit(), "kona");
  expect(b).toEqual({ value: "kona", cursor: 4 });
});

test("insertion happens at the cursor, not the end", () => {
  let b = edit("kna");
  b = press(b, { name: "left" }).edit; // between n and a
  b = press(b, { name: "left" }).edit; // between k and n
  b = type(b, "o");
  expect(b.value).toBe("kona");
  expect(b.cursor).toBe(2);
});

test("backspace erases before the cursor; delete erases under it", () => {
  const back = press(edit("kona"), { name: "backspace" }).edit;
  expect(back).toEqual({ value: "kon", cursor: 3 });

  const del = press(edit("kona", 0), { name: "delete" }).edit;
  expect(del).toEqual({ value: "ona", cursor: 0 });
});

test("backspace at the start and delete at the end are no-ops", () => {
  expect(press(edit("kona", 0), { name: "backspace" }).edit).toEqual({ value: "kona", cursor: 0 });
  expect(press(edit("kona"), { name: "delete" }).edit).toEqual({ value: "kona", cursor: 4 });
});

test("the cursor clamps to the ends of the text", () => {
  expect(press(edit("hi", 0), { name: "left" }).edit.cursor).toBe(0);
  expect(press(edit("hi"), { name: "right" }).edit.cursor).toBe(2);
});

test("home/end and ctrl+a/ctrl+e jump to the line's edges", () => {
  expect(press(edit("kona"), { name: "home" }).edit.cursor).toBe(0);
  expect(press(edit("kona", 0), { name: "end" }).edit.cursor).toBe(4);
  expect(press(edit("kona"), { name: "a", ctrl: true }).edit.cursor).toBe(0);
  expect(press(edit("kona", 0), { name: "e", ctrl: true }).edit.cursor).toBe(4);
});

test("ctrl+u/ctrl+k kill to the start/end of the line", () => {
  expect(press(edit("ada lovelace", 4), { name: "u", ctrl: true }).edit).toEqual({
    value: "lovelace",
    cursor: 0,
  });
  expect(press(edit("ada lovelace", 4), { name: "k", ctrl: true }).edit).toEqual({
    value: "ada ",
    cursor: 4,
  });
});

test("ctrl+w erases the word before the cursor, trailing space and all", () => {
  const b = press(edit("ada lovelace"), { name: "w", ctrl: true }).edit;
  expect(b).toEqual({ value: "ada", cursor: 3 });
});

test("enter submits and esc cancels, leaving the buffer untouched", () => {
  const buf = edit("kona");
  const submitted = applyKey(buf, { name: "return" });
  expect(submitted.action).toBe("submit");
  expect(submitted.edit).toBe(buf);

  expect(applyKey(buf, { name: "escape" }).action).toBe("cancel");
});

test("space is text; tab and stray control keys are ignored", () => {
  expect(type(edit("a"), " ").value).toBe("a ");
  expect(applyKey(edit("a"), { name: "tab", sequence: "\t" }).action).toBe("ignore");
  expect(applyKey(edit("a"), { name: "c", ctrl: true, sequence: "\x03" }).action).toBe("ignore");
  // arrow keys arrive as escape sequences; they must never land as text
  expect(applyKey(edit("a"), { name: "up", sequence: "\x1b[A" }).action).toBe("ignore");
});

test("a pasted run of characters lands as one insert", () => {
  const b = applyKey(edit(), { name: "paste", sequence: "ada lovelace" }).edit;
  expect(b).toEqual({ value: "ada lovelace", cursor: 12 });
});

test("windowOf shows the head while the cursor is inside the field", () => {
  expect(windowOf(edit("kona", 4), 10)).toEqual({ text: "kona", cursor: 4 });
});

test("windowOf scrolls text under the caret once it overflows", () => {
  // 12 chars in an 8-wide field, cursor at the end: the tail is what you see,
  // with one cell left over for the caret to sit in.
  const w = windowOf(edit("ada lovelace"), 8);
  expect(w.text).toBe("ovelace");
  expect(w.cursor).toBe(7);
  expect(w.cursor).toBeLessThan(8);
});

/**
 * Multi-line mode — the textarea. Same brain, different exit key: enter is a
 * newline and ctrl+d submits, which is what lets a note body contain blank
 * lines and still be saved from the keyboard.
 */
const multi = { multiline: true };
const typeIn = (buf: Edit, s: string): Edit =>
  [...s].reduce((b, ch) => applyKey(b, { name: ch, sequence: ch }, multi).edit, buf);

test("in a textarea enter inserts a newline instead of submitting", () => {
  const first = applyKey(edit("one"), { name: "return" }, multi);
  expect(first.action).toBe("edit");
  expect(first.edit).toEqual({ value: "one\n", cursor: 4 });
  expect(typeIn(first.edit, "two").value).toBe("one\ntwo");
});

test("ctrl+d (and ctrl+s) submit a textarea; both are inert in a one-line field", () => {
  const buf = edit("one\ntwo");
  expect(applyKey(buf, { name: "d", ctrl: true }, multi).action).toBe("submit");
  expect(applyKey(buf, { name: "s", ctrl: true }, multi).action).toBe("submit");
  expect(applyKey(buf, { name: "d", ctrl: true }).action).toBe("ignore");
  expect(applyKey(buf, { name: "s", ctrl: true }).action).toBe("ignore");
});

test("esc still cancels, and a one-line field still submits on enter", () => {
  expect(applyKey(edit("one\ntwo"), { name: "escape" }, multi).action).toBe("cancel");
  expect(applyKey(edit("one"), { name: "return" }).action).toBe("submit");
});

test("↑/↓ move between lines, keeping the column and clamping at the ends", () => {
  const buf = edit("alpha\nbeta\ngamma", 13); // "gam|ma" — line 3, column 2
  const up = applyKey(buf, { name: "up" }, multi).edit;
  expect(up.cursor).toBe(8); // "be|ta"
  const back = applyKey(up, { name: "down" }, multi).edit;
  expect(back.cursor).toBe(13);

  // A short line takes the caret to its end rather than past it.
  const short = applyKey(edit("alpha\nhi\ngamma", 14), { name: "up" }, multi).edit;
  expect(short.cursor).toBe(8); // end of "hi"

  // Nothing above the first line, nothing below the last.
  expect(applyKey(edit("alpha\nbeta", 2), { name: "up" }, multi).edit.cursor).toBe(2);
  expect(applyKey(edit("alpha\nbeta", 8), { name: "down" }, multi).edit.cursor).toBe(8);
  // ...and in a one-line field the arrows are not the editor's business.
  expect(applyKey(edit("alpha"), { name: "up", sequence: "\x1b[A" }).action).toBe("ignore");
});

test("the line bindings act on the cursor's line, not the whole buffer", () => {
  const buf = edit("alpha\nbeta gamma", 10); // inside "beta|"
  expect(applyKey(buf, { name: "home" }, multi).edit.cursor).toBe(6);
  expect(applyKey(buf, { name: "end" }, multi).edit.cursor).toBe(16);
  expect(applyKey(buf, { name: "a", ctrl: true }, multi).edit).toEqual({ value: buf.value, cursor: 6 });
  expect(applyKey(buf, { name: "u", ctrl: true }, multi).edit).toEqual({ value: "alpha\n gamma", cursor: 6 });
  expect(applyKey(buf, { name: "k", ctrl: true }, multi).edit).toEqual({ value: "alpha\nbeta", cursor: 10 });
  // ctrl+w stops at the line break rather than eating the line above.
  expect(applyKey(edit("alpha\nbeta", 6), { name: "w", ctrl: true }, multi).edit).toEqual({
    value: "alpha\nbeta",
    cursor: 6,
  });
});

test("backspace at the start of a line joins it to the one above", () => {
  const joined = applyKey(edit("one\ntwo", 4), { name: "backspace" }, multi).edit;
  expect(joined).toEqual({ value: "onetwo", cursor: 3 });
});

test("a pasted paragraph keeps its newlines in a textarea, and loses them in a field", () => {
  const pasted = applyKey(edit(), { name: "paste", sequence: "one\ntwo" }, multi).edit;
  expect(pasted.value).toBe("one\ntwo");
  expect(applyKey(edit(), { name: "paste", sequence: "one\ntwo" }).action).toBe("ignore");
});

test("frameOf splits hard newlines and word-wraps long lines", () => {
  const f = frameOf(edit("alpha beta gamma\ndelta", 0), 12, 6);
  expect(f.lines).toEqual(["alpha beta ", "gamma", "delta"]);
  expect(f.total).toBe(3);
  expect(f.cursor).toEqual({ row: 0, col: 0 });
});

test("frameOf puts the caret on the wrapped row it actually sits in", () => {
  // cursor 13 is inside "gamma", which wrapped onto the second display row.
  const f = frameOf(edit("alpha beta gamma", 13), 12, 6);
  expect(f.cursor).toEqual({ row: 1, col: 2 });
});

test("frameOf scrolls vertically to keep the caret in view", () => {
  const buf = edit("one\ntwo\nthree\nfour\nfive");
  const f = frameOf(buf, 20, 2);
  expect(f.lines).toEqual(["four", "five"]);
  expect(f.top).toBe(3);
  expect(f.cursor).toEqual({ row: 1, col: 4 });
  expect(f.total).toBe(5);

  // The caret at the top of the buffer shows the head instead.
  const head = frameOf(edit(buf.value, 0), 20, 2);
  expect(head.lines).toEqual(["one", "two"]);
  expect(head.top).toBe(0);
});

test("frameOf keeps a trailing empty line, so a blank line is visible", () => {
  const f = frameOf(edit("one\n\n"), 10, 4);
  expect(f.lines).toEqual(["one", "", ""]);
  expect(f.cursor).toEqual({ row: 2, col: 0 });
});
