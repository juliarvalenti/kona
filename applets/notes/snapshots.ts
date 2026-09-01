import { defineSnapshots } from "../../sdk/testing.ts";

export default defineSnapshots([
  {
    name: "lists jotted lines with a header count",
    state: () => ({
      cursor: 1,
      notes: [
        { id: "a1", text: "ship the notes applet", at: Date.now() },
        { id: "b2", text: "milk, eggs, coffee", at: Date.now() - 7_200_000 },
      ],
    }),
    width: 72,
    height: 16,
    contains: ["SCRATCHPAD", "2 notes", "ship the notes applet", "milk, eggs, coffee"],
  },
  {
    name: "an empty pad shows how to jot the first line",
    width: 72,
    height: 14,
    contains: ["0 notes", "nothing jotted yet", "notes.add"],
  },
]);
