import { test, expect } from "bun:test";
import { applyKey, edit, windowOf, type Edit, type KeyEvent } from "../host/editor.ts";

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
