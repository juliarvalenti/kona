import { test, expect } from "bun:test";
import { modeOf, resolveKey, type InputContext } from "../host/input.ts";
import { edit } from "../host/editor.ts";
import { defineApplet, text, type AppletDef, type AppletState, type InputNode, type Overlay } from "../sdk/index.ts";

/**
 * The input state machine: which mode owns the keyboard, and what one keypress
 * means inside it. This is the file that used to be an if-ladder in the host —
 * these tests pin the PRECEDENCE, so a future merge can't quietly hand the
 * wrong mode a key.
 */

const app = defineApplet<{ q: string }>({
  id: "demo",
  title: "Demo",
  initialState: { q: "" },
  verbs: {},
  view: () => [text("body")],
  nav: { up: "up", down: "down", select: "open", back: "close", canBack: () => true },
  keymap: { r: "refresh", "ctrl+s": { verb: "save", args: { now: true }, label: "save" } },
  search: { verb: "find", placeholder: "search…" },
});

const field: InputNode = {
  kind: "input",
  id: "name",
  value: "ada",
  focus: true,
  submit: "save",
  cancel: "cancel",
  change: "live",
};

const dialog: Overlay = { node: text("sure?"), confirm: "ok", dismiss: "cancel", keymap: { d: "delete" } };

const ctx = (over: Partial<InputContext> = {}): InputContext => ({
  def: app as unknown as AppletDef,
  state: { q: "" } as AppletState,
  overlay: null,
  field: null,
  search: null,
  draft: null,
  ...over,
});

const press = (name: string, extra: { ctrl?: boolean; sequence?: string } = {}) => ({ name, ...extra });

test("the mode is decided by one precedence: overlay, search, field, normal", () => {
  expect(modeOf(ctx({ def: null }))).toBe("launcher");
  expect(modeOf(ctx())).toBe("normal");
  expect(modeOf(ctx({ search: edit("mars") }))).toBe("search");
  expect(modeOf(ctx({ field }))).toBe("field");
  expect(modeOf(ctx({ overlay: dialog }))).toBe("overlay");

  // A dialog outranks an open search line…
  expect(modeOf(ctx({ overlay: dialog, search: edit("mars") }))).toBe("overlay");
  // …but a field INSIDE the dialog outranks the dialog: it has the keyboard.
  expect(modeOf(ctx({ overlay: dialog, field }))).toBe("field");
  // A search line outranks a focused field in the body.
  expect(modeOf(ctx({ search: edit("mars"), field }))).toBe("search");
});

test("ctrl+c quits from every mode", () => {
  for (const over of [{}, { overlay: dialog }, { search: edit("x") }, { field }, { def: null }]) {
    expect(resolveKey(ctx(over), press("c", { ctrl: true }))).toEqual({ kind: "quit" });
  }
});

test("normal mode matches the keymap before the nav intents", () => {
  expect(resolveKey(ctx(), press("r"))).toEqual({ kind: "verb", verb: "refresh", args: {} });
  expect(resolveKey(ctx(), press("s", { ctrl: true }))).toEqual({ kind: "verb", verb: "save", args: { now: true } });
  expect(resolveKey(ctx(), press("j"))).toEqual({ kind: "move", delta: 1 });
  expect(resolveKey(ctx(), press("up"))).toEqual({ kind: "move", delta: -1 });
  expect(resolveKey(ctx(), press("return"))).toEqual({ kind: "select" });
  expect(resolveKey(ctx(), press("escape"))).toEqual({ kind: "back" });
  expect(resolveKey(ctx(), press("/", { sequence: "/" }))).toEqual({ kind: "searchOpen" });
  expect(resolveKey(ctx(), press("z"))).toEqual({ kind: "none" });
});

test("an overlay traps what would move the body, and fires its own keys", () => {
  const open = ctx({ overlay: dialog });
  expect(resolveKey(open, press("return"))).toEqual({ kind: "verb", verb: "ok", args: {} });
  expect(resolveKey(open, press("escape"))).toEqual({ kind: "verb", verb: "cancel", args: {} });
  expect(resolveKey(open, press("d"))).toEqual({ kind: "verb", verb: "delete", args: {} });
  // Trapped: the applet's own keymap and nav are inert behind a dialog.
  expect(resolveKey(open, press("r"))).toEqual({ kind: "none" });
  expect(resolveKey(open, press("down"))).toEqual({ kind: "none" });
});

test("a dialog with no exit lets back fall through to the applet", () => {
  const stuck = ctx({ overlay: { node: text("no way out") } });
  expect(resolveKey(stuck, press("escape"))).toEqual({ kind: "back" });
  expect(resolveKey(stuck, press("down"))).toEqual({ kind: "none" }); // still trapped
});

test("search mode edits the footer line and hands the query over on enter", () => {
  const open = ctx({ search: edit("mar") });
  expect(resolveKey(open, press("s", { sequence: "s" }))).toMatchObject({
    kind: "searchEdit",
    edit: { value: "mars" },
  });
  expect(resolveKey(open, press("return"))).toEqual({ kind: "searchSubmit", q: "mar" });
  expect(resolveKey(open, press("escape"))).toEqual({ kind: "searchCancel" });
  // `/` is text once the line is open, not a second search.
  expect(resolveKey(open, press("/", { sequence: "/" }))).toMatchObject({ kind: "searchEdit" });
});

test("a focused field takes every key as text until enter or esc", () => {
  const typing = ctx({ field, draft: { id: "name", edit: edit("ada") } });
  expect(resolveKey(typing, press("!", { sequence: "!" }))).toMatchObject({
    kind: "fieldEdit",
    edit: { value: "ada!" },
    changed: true,
  });
  // Arrows move the caret; they never navigate the body.
  expect(resolveKey(typing, press("left"))).toMatchObject({ kind: "fieldEdit", changed: false });
  expect(resolveKey(typing, press("/", { sequence: "/" }))).toMatchObject({ kind: "fieldEdit" });
  expect(resolveKey(typing, press("return"))).toMatchObject({ kind: "fieldSubmit", value: "ada" });
  expect(resolveKey(typing, press("escape"))).toMatchObject({ kind: "fieldCancel" });
});

test("a field with no draft yet types on top of the value in state", () => {
  expect(resolveKey(ctx({ field }), press("!", { sequence: "!" }))).toMatchObject({
    kind: "fieldEdit",
    edit: { value: "ada!" },
  });
});

test("a key the field editor ignores still belongs to the dialog around it", () => {
  const inDialog = ctx({ overlay: dialog, field, draft: { id: "name", edit: edit("ada") } });
  expect(resolveKey(inDialog, press("tab"))).toEqual({ kind: "none" });
  const withTab = ctx({
    overlay: { ...dialog, keymap: { tab: "nextField" } },
    field,
    draft: { id: "name", edit: edit("ada") },
  });
  expect(resolveKey(withTab, press("tab"))).toEqual({ kind: "verb", verb: "nextField", args: {} });
});

test("the launcher only moves and opens", () => {
  const home = ctx({ def: null });
  expect(resolveKey(home, press("k"))).toEqual({ kind: "launcherMove", delta: -1 });
  expect(resolveKey(home, press("down"))).toEqual({ kind: "launcherMove", delta: 1 });
  expect(resolveKey(home, press("return"))).toEqual({ kind: "launcherOpen" });
  expect(resolveKey(home, press("r"))).toEqual({ kind: "none" });
});
