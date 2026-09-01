import { defineApplet, text, spacer, col, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow } from "../../sdk/components.ts";

/**
 * notes — a persistent scratchpad. Jot a line, it survives restarts (the daemon
 * writes non-ephemeral state to disk).
 *
 * The bimodal seam is unusually literal here: `add` is ONE verb with two
 * callers. You press `/`, type a line and hit enter — the host sends `{q}` to
 * `notes.add`. An agent posts `{"text":"..."}` to the same verb. Neither the
 * applet nor the state can tell which happened.
 *
 * Input note: the host's `/` line editor is the only text entry the platform
 * has today, so it doubles as the capture prompt (hence the placeholder). When
 * the text-input primitive lands (#6) this applet should swap `search` for a
 * focused input node in the view — the verbs below stay exactly as they are.
 */

interface Note {
  id: string;
  text: string;
  at: number; // epoch ms
}

interface NotesState {
  notes: Note[];
  cursor: number;
  /**
   * Snapshots of `notes` taken before each mutation — `undo` pops one. Bounded
   * to HISTORY_MAX, and persisted with the rest of the state, so undo survives
   * a daemon restart the same way the notes do.
   */
  history: Note[][];
}

const PAPER = "#e0af68";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const HISTORY_MAX = 10;

/** Time the note was jotted: "14:32" today, "3 Sep" this year, else "3 Sep 24". */
function stamp(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md} ${String(d.getFullYear()).slice(2)}`;
}

/** A note is one line: collapse whitespace so a pasted blob stays a row. */
function oneLine(input: unknown): string {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
}

/** Resolve `{index}` / `{id}` (agent) or the cursor (keypress) to a position. */
function indexOf(state: NotesState, args: Record<string, unknown>): number {
  if (typeof args.index === "number") return args.index;
  if (typeof args.id === "string") return state.notes.findIndex((n) => n.id === args.id);
  return state.cursor;
}

function clampCursor(state: NotesState) {
  state.cursor = Math.max(0, Math.min(state.cursor, state.notes.length - 1));
}

/** Remember the current list so `undo` can put it back. */
function snapshot(state: NotesState) {
  state.history = [...state.history.slice(-(HISTORY_MAX - 1)), state.notes.map((n) => ({ ...n }))];
}

export default defineApplet<NotesState>({
  id: "notes",
  title: "Notes",
  summary: "A scratchpad that survives restarts. Agents jot lines too.",
  labels: ["scratch"],
  initialState: { notes: [], cursor: 0, history: [] },

  docs: {
    add: { doc: "Jot a line. Newest first.", args: { text: "ship the skill generator" } },
    edit: { doc: "Replace a note's text, by `id` or `index`.", args: { id: "a1b2c3d4", text: "ship it tomorrow" } },
    remove: { doc: "Delete a note, by `id` or `index`. Undoable.", args: { id: "a1b2c3d4" } },
    clear: "Wipe the pad. Undoable.",
    undo: "Step back one mutation (add, edit, remove, clear).",
  },

  verbs: {
    /**
     * Add a line. `text` (agent) or `q` (the host's `/` prompt) — same verb.
     * Newest first, and the cursor follows the new note so it's selected.
     */
    add(args, { state, emit }) {
      const body = oneLine(args.text ?? args.note ?? args.q);
      if (!body) return { added: false, reason: "empty note" };
      snapshot(state);
      const note: Note = { id: crypto.randomUUID().slice(0, 8), text: body, at: Date.now() };
      state.notes.unshift(note);
      state.cursor = 0;
      emit();
      return { added: true, id: note.id, count: state.notes.length };
    },

    /** Replace a note's text (by index, id, or the selected row). */
    edit(args, { state, emit }) {
      const i = indexOf(state, args);
      const target = state.notes[i];
      const body = oneLine(args.text ?? args.note ?? args.q);
      if (!target) return { error: "no such note" };
      if (!body) return { error: "empty note" };
      snapshot(state);
      target.text = body;
      state.cursor = i;
      emit();
      return { id: target.id, text: target.text };
    },

    /** Delete a note (by index, id, or the selected row). Undoable. */
    remove(args, { state, emit }) {
      const i = indexOf(state, args);
      const target = state.notes[i];
      if (!target) return { error: "no such note" };
      snapshot(state);
      state.notes.splice(i, 1);
      clampCursor(state);
      emit();
      return { removed: target.text, count: state.notes.length };
    },

    /** Wipe the pad. Undoable — the whole list comes back with `undo`. */
    clear(_args, { state, emit }) {
      if (!state.notes.length) return { cleared: 0 };
      snapshot(state);
      const n = state.notes.length;
      state.notes = [];
      state.cursor = 0;
      emit();
      return { cleared: n };
    },

    /** Step back one mutation (add, edit, remove, clear). */
    undo(_args, { state, emit }) {
      const prev = state.history.pop();
      if (!prev) return { undone: false };
      state.notes = prev;
      clampCursor(state);
      emit();
      return { undone: true, count: state.notes.length };
    },

    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(Math.max(0, state.notes.length - 1), state.cursor + 1);
      emit();
    },
  },

  nav: { up: "up", down: "down" },

  // The only text entry the host has today. Enter fires `add` with `{q}`.
  search: { verb: "add", placeholder: "jot a line — enter saves, esc cancels" },

  keymap: {
    d: { verb: "remove", label: "delete" },
    u: { verb: "undo", label: "undo" },
  },

  accent: () => PAPER,

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const nodes: ViewNode[] = [
      text(`SCRATCHPAD  ·  ${state.notes.length} ${state.notes.length === 1 ? "note" : "notes"}`, { color: PAPER }),
      divider(W - 1),
    ];

    if (!state.notes.length) {
      nodes.push(
        spacer(),
        text("nothing jotted yet", { dim: true }),
        text("press / to jot a line · agents call notes.add", { color: DIM }),
      );
      return [col(nodes)];
    }

    state.notes.forEach((n, i) => {
      nodes.push(
        recordRow(
          [
            { text: n.text, grow: true },
            { text: stamp(n.at), width: 9, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: PAPER, color: FG },
        ),
      );
    });

    return [col(nodes)];
  },
});
