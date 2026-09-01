import { test, expect } from "bun:test";
import type { AppletCtx, ViewNode } from "../sdk/index.ts";
import notes from "../applets/notes/index.ts";

/**
 * The notes applet is a reducer over a persisted list. These drive it exactly
 * like the daemon does — including the two callers of `add` (an agent's
 * `{text}` and the host's `/` prompt `{q}`), which must be indistinguishable.
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
    texts: () => state.notes.map((n) => n.text),
  };
}

test("add prepends, selects the new note, and emits", () => {
  const h = harness();
  h.call("add", { text: "buy milk" });
  h.call("add", { text: "call mum" });
  expect(h.texts()).toEqual(["call mum", "buy milk"]);
  expect(h.state.cursor).toBe(0);
  expect(h.emits()).toBe(2);
});

test("add takes `q` from the host prompt and `text` from an agent alike", () => {
  const h = harness();
  h.call("add", { q: "typed by a human" });
  h.call("add", { text: "posted by an agent" });
  expect(h.texts()).toEqual(["posted by an agent", "typed by a human"]);
});

test("add collapses whitespace and refuses an empty line", () => {
  const h = harness();
  h.call("add", { text: "  two   lines\nin one  " });
  expect(h.texts()).toEqual(["two lines in one"]);
  const res = h.call("add", { q: "   " }) as { added: boolean };
  expect(res.added).toBe(false);
  expect(h.state.notes).toHaveLength(1);
});

test("remove deletes the selected note by default", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" }); // cursor 0
  h.call("remove");
  expect(h.texts()).toEqual(["one"]);
});

test("remove targets an explicit index or id", () => {
  const h = harness();
  h.call("add", { text: "one" });
  const added = h.call("add", { text: "two" }) as { id: string };
  h.call("remove", { index: 1 });
  expect(h.texts()).toEqual(["two"]);
  h.call("remove", { id: added.id });
  expect(h.texts()).toEqual([]);
  expect(h.call("remove", { index: 4 })).toMatchObject({ error: "no such note" });
});

test("removing the last note keeps the cursor in range", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" });
  h.call("down"); // cursor 1 (the older note)
  h.call("remove");
  expect(h.state.cursor).toBe(0);
  h.call("remove");
  expect(h.state.notes).toHaveLength(0);
  expect(h.state.cursor).toBe(0);
});

test("edit replaces text in place", () => {
  const h = harness();
  h.call("add", { text: "buy milk" });
  h.call("edit", { text: "buy oat milk" });
  expect(h.texts()).toEqual(["buy oat milk"]);
  expect(h.call("edit", { index: 0, text: "  " })).toMatchObject({ error: "empty note" });
  expect(h.texts()).toEqual(["buy oat milk"]); // unchanged
});

test("undo steps back through add, edit, remove and clear", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" });
  h.call("remove", { index: 1 });
  expect(h.texts()).toEqual(["two"]);
  h.call("undo");
  expect(h.texts()).toEqual(["two", "one"]);

  h.call("edit", { index: 0, text: "TWO" });
  h.call("undo");
  expect(h.texts()).toEqual(["two", "one"]);

  h.call("clear");
  expect(h.texts()).toEqual([]);
  h.call("undo");
  expect(h.texts()).toEqual(["two", "one"]);

  h.call("undo"); // back past the second add
  expect(h.texts()).toEqual(["one"]);
});

test("undo on a fresh pad is a no-op", () => {
  const h = harness();
  expect(h.call("undo")).toMatchObject({ undone: false });
  expect(h.state.notes).toHaveLength(0);
});

test("clear reports how many it wiped and is idle when empty", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" });
  expect(h.call("clear")).toMatchObject({ cleared: 2 });
  expect(h.call("clear")).toMatchObject({ cleared: 0 });
});

test("up/down clamp at the ends of the list", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" });
  h.call("up");
  expect(h.state.cursor).toBe(0);
  h.call("down");
  h.call("down");
  expect(h.state.cursor).toBe(1);
});

test("the pad persists — notes are plain JSON, not ephemeral", () => {
  expect(notes.ephemeral).toBeUndefined();
  const h = harness();
  h.call("add", { text: "survives a restart" });
  const roundTripped = JSON.parse(JSON.stringify(h.state)) as NotesState;
  expect(roundTripped.notes[0]!.text).toBe("survives a restart");
});

// walk the view tree (rows/cols nest children) and collect every node
function flatten(nodes: ReturnType<typeof notes.view>): Array<Exclude<ViewNode, string>> {
  const out: Array<Exclude<ViewNode, string>> = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return;
    out.push(n);
    if (n.kind === "row" || n.kind === "col") n.children.forEach(visit);
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(visit);
  return out;
}

test("view marks exactly one row as the focused selection", () => {
  const h = harness();
  h.call("add", { text: "one" });
  h.call("add", { text: "two" });
  h.call("down"); // select "one"
  const focused = flatten(notes.view(h.state, { width: 60, height: 20 })).filter(
    (n) => n.kind === "text" && n.focus,
  );
  expect(focused).toHaveLength(1);
  expect((focused[0] as { text: string }).text).toContain("one");
});

test("an empty pad views as a prompt, not a blank frame", () => {
  const h = harness();
  const said = flatten(notes.view(h.state, { width: 60, height: 20 }))
    .map((n) => (n.kind === "text" ? n.text : ""))
    .join(" ");
  expect(said).toContain("nothing jotted yet");
  expect(said).toContain("notes.add");
});
