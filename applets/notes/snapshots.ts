import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * Built per run, not at import: the shot runner pins `Date.now()` while it
 * renders (core/shots.ts), and a note stamped at module-load time would carry
 * the real wall clock into the gallery image — which then goes stale a minute
 * later and fails the committed-shots guard.
 */
const notes = () => [
  {
    id: "a1",
    title: "release plan",
    body: "cut rc1 friday\nfreeze monday\nship when the suite is green",
    at: Date.now() - 7_200_000,
    updated: Date.now(),
  },
  { id: "b2", title: "groceries", body: "milk\neggs\ncoffee", at: Date.now() - 86_400_000, updated: Date.now() - 86_400_000 },
];

export default defineSnapshots([
  {
    name: "lists titles with a preview and a count",
    hero: true,
    state: () => ({ notes: notes(), cursor: 1, query: "", open: null, draft: null }),
    width: 72,
    height: 16,
    contains: ["NOTEPAD", "2 notes", "release plan", "groceries", "milk"],
  },
  {
    name: "an open note shows its body a line at a time",
    state: () => ({ notes: notes(), cursor: 0, query: "", open: "a1", draft: null }),
    width: 72,
    height: 18,
    contains: ["release plan", "cut rc1 friday", "freeze monday", "ship when the suite is green"],
  },
  {
    name: "a filter says what it matched, and never creates",
    state: () => ({ notes: notes(), cursor: 0, query: "milk", open: null, draft: null }),
    width: 72,
    height: 14,
    contains: ["1 note", "groceries", "matching"],
    excludes: ["release plan"],
  },
  {
    name: "the composer floats over the list with both fields",
    state: () => ({
      notes: notes(),
      cursor: 0,
      query: "",
      open: null,
      draft: { id: null, title: "standup", body: "kona notes\nthe multi-line editor", field: "body" },
    }),
    width: 72,
    height: 22,
    contains: ["new note", "standup", "kona notes", "the multi-line editor", "tab switches field"],
  },
  {
    name: "an empty pad shows how to write the first note",
    width: 72,
    height: 14,
    contains: ["0 notes", "no notes yet", "notes.add"],
  },
]);
