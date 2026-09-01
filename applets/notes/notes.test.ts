import { test, expect } from "bun:test";
import type { AppletCtx, ViewNode, InputNode } from "../../sdk/index.ts";
import notes from "./index.ts";

/**
 * The notepad is a reducer over a persisted list. These drive it exactly like
 * the daemon does — including the two callers of every verb (a keypress and an
 * agent's JSON), which must be indistinguishable.
 */
type NotesState = typeof notes.initialState;

function harness() {
  const state: NotesState = structuredClone(notes.initialState);
  let emits = 0;
  const ctx: AppletCtx<NotesState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => notes.verbs[verb]!(args, ctx),
    titles: () => state.notes.map((n) => n.title),
  };
}

test("add writes a titled, multi-line note and selects it", () => {
  const h = harness();
  const res = h.call("add", { title: "release plan", body: "cut rc1 friday\nfreeze monday" }) as {
    added: boolean;
    id: string;
  };
  expect(res.added).toBe(true);
  expect(h.state.notes[0]).toMatchObject({ title: "release plan", body: "cut rc1 friday\nfreeze monday" });
  expect(h.state.cursor).toBe(0);
  expect(h.emits()).toBe(1);
});

test("a body keeps its newlines — a note is not a collapsed line", () => {
  const h = harness();
  h.call("add", { title: "shopping", body: "milk\n\neggs\ncoffee" });
  expect(h.state.notes[0]!.body.split("\n")).toEqual(["milk", "", "eggs", "coffee"]);
});

test("add takes a one-line `text` blob: first line titles it, the rest is body", () => {
  const h = harness();
  h.call("add", { text: "standup\nkona notes\nthe editor" });
  expect(h.state.notes[0]).toMatchObject({ title: "standup", body: "kona notes\nthe editor" });

  // The old one-liner habit (workflow steps still send it) stays meaningful.
  h.call("add", { text: "ship the skill generator" });
  expect(h.state.notes[0]).toMatchObject({ title: "ship the skill generator", body: "" });
});

test("add refuses an empty note", () => {
  const h = harness();
  expect(h.call("add", { text: "   \n\n " })).toMatchObject({ added: false });
  expect(h.call("add", { title: "  ", body: "" })).toMatchObject({ added: false });
  expect(h.state.notes).toHaveLength(0);
});

test("edit with title/body rewrites in place and stamps the edit", () => {
  const h = harness();
  const { id } = h.call("add", { title: "plan", body: "one" }) as { id: string };
  const before = h.state.notes[0]!.updated;
  h.call("edit", { id, title: "plan", body: "one\ntwo" });
  expect(h.state.notes[0]!.body).toBe("one\ntwo");
  expect(h.state.notes[0]!.updated).toBeGreaterThanOrEqual(before);
  expect(h.call("edit", { id: "nope", body: "x" })).toMatchObject({ error: "no such note" });
});

test("edit with no text opens the composer on that note — what `e` does", () => {
  const h = harness();
  h.call("add", { title: "plan", body: "one" });
  h.call("edit");
  expect(h.state.draft).toMatchObject({ title: "plan", body: "one", field: "title" });
});

test("the composer creates a note through the same verbs a human's keys fire", () => {
  const h = harness();
  h.call("compose");
  expect(h.state.draft).toMatchObject({ id: null, field: "title" });

  // typing in the title (the field's `change` verb, one call per keystroke)
  h.call("field", { id: "note.title", value: "groceries" });
  // enter in the title moves to the body, carrying the value with it
  h.call("next", { id: "note.title", value: "groceries" });
  expect(h.state.draft!.field).toBe("body");
  // ctrl+d in the body commits
  h.call("save", { id: "note.body", value: "milk\neggs" });

  expect(h.state.draft).toBeNull();
  expect(h.state.notes[0]).toMatchObject({ title: "groceries", body: "milk\neggs" });
  // and you land in the note you just wrote
  expect(h.state.open).toBe(h.state.notes[0]!.id);
});

test("the composer edits an existing note rather than adding a second one", () => {
  const h = harness();
  const { id } = h.call("add", { title: "plan", body: "one" }) as { id: string };
  h.call("edit", { id });
  h.call("save", { id: "note.body", value: "one\ntwo" });
  expect(h.state.notes).toHaveLength(1);
  expect(h.state.notes[0]).toMatchObject({ id, title: "plan", body: "one\ntwo" });
});

test("saving an empty composer writes nothing; dismiss drops the draft", () => {
  const h = harness();
  h.call("compose");
  expect(h.call("save", { id: "note.body", value: "  " })).toMatchObject({ saved: false });
  expect(h.state.notes).toHaveLength(0);
  expect(h.state.draft).toBeNull();

  h.call("compose");
  h.call("field", { id: "note.title", value: "half typed" });
  h.call("dismiss");
  expect(h.state.draft).toBeNull();
  expect(h.state.notes).toHaveLength(0);
});

test("tab moves between the fields without losing what was typed", () => {
  const h = harness();
  h.call("compose");
  h.call("field", { id: "note.title", value: "one" });
  h.call("next");
  h.call("field", { id: "note.body", value: "two\nthree" });
  h.call("next");
  expect(h.state.draft).toMatchObject({ title: "one", body: "two\nthree", field: "title" });
});

test("search filters over titles AND bodies, and never creates", () => {
  const h = harness();
  h.call("add", { title: "release plan", body: "cut rc1" });
  h.call("add", { title: "groceries", body: "milk, release the cheese" });
  h.call("add", { title: "standup", body: "nothing to report" });

  expect(h.call("search", { q: "release" })).toMatchObject({ query: "release", matched: 2 });
  expect(h.state.notes).toHaveLength(3); // a filter is not a mutation
  expect(h.call("search", { q: "" })).toMatchObject({ matched: 3 });
});

test("a filtered cursor addresses the row you can see", () => {
  const h = harness();
  h.call("add", { title: "one", body: "keep" });
  h.call("add", { title: "two", body: "drop" });
  h.call("add", { title: "three", body: "keep" });
  h.call("search", { q: "keep" }); // rows: three, one
  h.call("down"); // "one"
  expect(h.call("open")).toMatchObject({ title: "one" });
  h.call("back"); // leaves the note
  h.call("remove"); // the selected row, not notes[1]
  expect(h.titles()).toEqual(["three", "two"]);
});

test("back walks out one level at a time: note, filter, then the launcher", () => {
  const h = harness();
  h.call("add", { title: "one", body: "x" });
  h.call("search", { q: "one" });
  h.call("open");
  expect(h.call("back")).toMatchObject({ at: "list" });
  expect(h.state.open).toBeNull();
  h.call("back");
  expect(h.state.query).toBe("");
  expect(h.call("back")).toMatchObject({ at: "list" }); // nothing left to pop
});

test("a note written under a filter that hides it still shows up", () => {
  const h = harness();
  h.call("add", { title: "release plan", body: "" });
  h.call("search", { q: "release" });
  h.call("add", { title: "groceries", body: "milk" });
  expect(h.state.query).toBe("");
  expect(h.state.cursor).toBe(0);
});

test("remove deletes the open note and returns you to the list", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  h.call("open", { index: 0 });
  h.call("remove");
  expect(h.titles()).toEqual(["one"]);
  expect(h.state.open).toBeNull();
});

test("remove targets an explicit index or id", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  const added = h.call("add", { title: "two", body: "" }) as { id: string };
  h.call("remove", { index: 1 });
  expect(h.titles()).toEqual(["two"]);
  h.call("remove", { id: added.id });
  expect(h.titles()).toEqual([]);
  expect(h.call("remove", { index: 4 })).toMatchObject({ error: "no such note" });
});

test("removing the last note keeps the cursor in range", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  h.call("down");
  h.call("remove");
  expect(h.state.cursor).toBe(0);
  h.call("remove");
  expect(h.state.notes).toHaveLength(0);
  expect(h.state.cursor).toBe(0);
});

test("undo steps back through add, edit, remove, clear and the composer", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  h.call("remove", { index: 1 });
  expect(h.titles()).toEqual(["two"]);
  h.call("undo");
  expect(h.titles()).toEqual(["two", "one"]);

  h.call("edit", { index: 0, title: "TWO" });
  h.call("undo");
  expect(h.titles()).toEqual(["two", "one"]);

  h.call("compose");
  h.call("save", { id: "note.title", value: "three" });
  expect(h.titles()).toEqual(["three", "two", "one"]);
  h.call("undo");
  expect(h.titles()).toEqual(["two", "one"]);

  h.call("clear");
  expect(h.titles()).toEqual([]);
  h.call("undo");
  expect(h.titles()).toEqual(["two", "one"]);
});

test("undo on a fresh pad is a no-op", () => {
  const h = harness();
  expect(h.call("undo")).toMatchObject({ undone: false });
  expect(h.state.notes).toHaveLength(0);
});

test("clear reports how many it wiped and is idle when empty", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  expect(h.call("clear")).toMatchObject({ cleared: 2 });
  expect(h.call("clear")).toMatchObject({ cleared: 0 });
});

test("up/down clamp at the ends of the list", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  h.call("up");
  expect(h.state.cursor).toBe(0);
  h.call("down");
  h.call("down");
  expect(h.state.cursor).toBe(1);
});

test("the pad persists — notes are plain JSON, not ephemeral", () => {
  expect(notes.ephemeral).toBeUndefined();
  const h = harness();
  h.call("add", { title: "survives", body: "a restart\nand another" });
  const roundTripped = JSON.parse(JSON.stringify(h.state)) as NotesState;
  expect(roundTripped.notes[0]!.body).toBe("a restart\nand another");
});

// walk the view tree (rows/cols/boxes nest children) and collect every node
function flatten(nodes: ViewNode | ViewNode[]): Array<Exclude<ViewNode, string>> {
  const out: Array<Exclude<ViewNode, string>> = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return;
    out.push(n);
    if (n.kind === "row" || n.kind === "col" || n.kind === "box") n.children.forEach(visit);
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(visit);
  return out;
}

const said = (nodes: ViewNode | ViewNode[]) =>
  flatten(nodes)
    .map((n) => (n.kind === "text" ? n.text : ""))
    .join(" ");

test("view marks exactly one row as the focused selection", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("add", { title: "two", body: "" });
  h.call("down"); // select "one"
  const focused = flatten(notes.view(h.state, { width: 60, height: 20 })).filter(
    (n) => n.kind === "text" && n.focus,
  );
  expect(focused).toHaveLength(1);
  expect((focused[0] as { text: string }).text).toContain("one");
});

test("an open note renders its body a line at a time", () => {
  const h = harness();
  h.call("add", { title: "shopping", body: "milk\neggs\ncoffee" });
  h.call("open");
  const lines = flatten(notes.view(h.state, { width: 60, height: 20 }))
    .filter((n) => n.kind === "text")
    .map((n) => (n as { text: string }).text);
  expect(lines).toContain("milk");
  expect(lines).toContain("eggs");
  expect(lines).toContain("coffee");
});

test("an empty pad views as a prompt, not a blank frame", () => {
  const h = harness();
  const words = said(notes.view(h.state, { width: 60, height: 20 }));
  expect(words).toContain("no notes yet");
  expect(words).toContain("notes.add");
});

test("a filter with no matches says so instead of looking empty", () => {
  const h = harness();
  h.call("add", { title: "one", body: "" });
  h.call("search", { q: "zzz" });
  expect(said(notes.view(h.state, { width: 60, height: 20 }))).toContain("nothing matches");
});

test("the composer is an overlay with a single-line title and a multi-line body", () => {
  const h = harness();
  h.call("compose");
  const overlay = notes.overlay!(h.state)!;
  expect(overlay).not.toBeNull();
  const fields = flatten(overlay.node).filter((n): n is InputNode => n.kind === "input");
  expect(fields.map((f) => f.id)).toEqual(["note.title", "note.body"]);

  const [title, body] = fields as [InputNode, InputNode];
  expect(title.multiline).toBeFalsy();
  expect(title.focus).toBe(true); // the composer opens on the title
  expect(body.multiline).toBe(true);
  expect(body.submit).toBe("save");
  // Every field writes back on each keystroke, so tab can't lose text.
  expect(fields.every((f) => f.change === "field" && f.cancel === "dismiss")).toBe(true);

  h.call("next");
  const focusedNow = flatten(notes.overlay!(h.state)!.node).filter(
    (n): n is InputNode => n.kind === "input" && !!n.focus,
  );
  expect(focusedNow.map((f) => f.id)).toEqual(["note.body"]);
});

test("no composer, no overlay — the list keeps its own keys", () => {
  const h = harness();
  expect(notes.overlay!(h.state)).toBeNull();
});

test("a pad written by the old one-line applet migrates on boot", () => {
  // What was on disk: {id, text, at} — no title, no body, no updated.
  const state = {
    ...structuredClone(notes.initialState),
    notes: [{ id: "a1", text: "ship the skill generator", at: 1_700_000_000_000 }],
  } as unknown as NotesState;
  let emits = 0;
  notes.init!({ state, emit: () => void emits++ });

  expect(state.notes[0]).toEqual({
    id: "a1",
    title: "ship the skill generator",
    body: "",
    at: 1_700_000_000_000,
    updated: 1_700_000_000_000,
  });
  expect(emits).toBe(1);

  // ...and a second boot leaves the migrated pad alone.
  notes.init!({ state, emit: () => void emits++ });
  expect(emits).toBe(1);
});
