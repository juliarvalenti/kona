import { defineApplet, text, spacer, col, row, input, textarea, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow, modal, field as labelled } from "../../sdk/components.ts";
import { renderMarkdown } from "../../sdk/markdown.ts";

/**
 * notes — a notepad. A note has a TITLE and a multi-line BODY: you create one,
 * read it, edit it in place, and search across the lot. Everything survives a
 * restart (the daemon persists non-ephemeral state) and every mutation is
 * undoable.
 *
 * The bimodal seam is unusually literal here: the composer is a modal with two
 * real fields, and a human filling them in fires exactly the verbs an agent
 * calls over HTTP — `notes.add {"title":"…","body":"…"}` is what enter does.
 * There is nothing keyboard-only, and nothing agent-only.
 *
 * `/` is a SEARCH, over titles and bodies both; `n` writes a new note. The two
 * were once the same key, which is how you end up with a feed instead of a pad.
 */

interface Note {
  id: string;
  title: string;
  /** Free text, newlines and all — that is the point of a notepad. */
  body: string;
  at: number; // created, epoch ms
  updated: number; // last edited
}

/** The composer's contents. Non-null exactly while the modal is up. */
interface Draft {
  /** The note being edited, or null while writing a new one. */
  id: string | null;
  title: string;
  body: string;
  /** Which field has the keyboard. `next` (tab) swaps it. */
  field: "title" | "body";
}

interface NotesState {
  notes: Note[];
  /** Row in the CURRENTLY VISIBLE (filtered) list, not an index into `notes`. */
  cursor: number;
  /** The live filter over title+body. Empty means "everything". */
  query: string;
  /** id of the note being read full-screen, or null on the list. */
  open: string | null;
  draft: Draft | null;
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
/** Composer geometry. The overlay gets no viewport, so the modal is sized once. */
const FORM_W = 56;
const FIELD_W = 44;
const BODY_ROWS = 8;

/** Time the note was written: "14:32" today, "3 Sep" this year, else "3 Sep 24". */
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

/** A title is one line: collapse whitespace so a pasted blob stays a heading. */
function oneLine(input: unknown): string {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
}

/** A body keeps its newlines; only trailing blank space goes. */
function asBody(input: unknown): string {
  return typeof input === "string" ? input.replace(/[ \t]+$/gm, "").replace(/\s+$/, "") : "";
}

/**
 * Split a blob into a note: the first line titles it, the rest is the body.
 * This is what makes the old one-line `add {"text":"…"}` still mean something
 * sensible — and what a paste into an empty composer should do anyway.
 */
function split(blob: string): { title: string; body: string } {
  const lines = blob.replace(/\r/g, "").split("\n");
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (first === -1) return { title: "", body: "" };
  return { title: oneLine(lines[first]), body: asBody(lines.slice(first + 1).join("\n")) };
}

/** Untitled notes get their heading from the body, so no row is ever blank. */
function heading(title: string, body: string): string {
  if (title) return title;
  const line = oneLine(body.split("\n").find((l) => l.trim().length > 0) ?? "");
  return line ? line.slice(0, 60) : "untitled";
}

/** The first body line, for the list's preview column. */
function preview(n: Note): string {
  const rest = n.body.split("\n").filter((l) => l.trim().length > 0);
  // An untitled note already shows its first line as the heading; don't repeat it.
  const skip = n.title ? 0 : 1;
  return oneLine(rest.slice(skip).join(" "));
}

/** Notes matching the live filter, in list order (newest first). */
function visible(state: NotesState): Note[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.notes;
  return state.notes.filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(q));
}

/**
 * Resolve a target to a position in `notes`: `{id}` (an agent's stable handle),
 * `{index}` (a row in the visible list — what a mouse click sends), the note
 * being read, or the cursor. -1 when there is nothing to act on.
 */
function indexOf(state: NotesState, args: Record<string, unknown>): number {
  if (typeof args.id === "string") return state.notes.findIndex((n) => n.id === args.id);
  const rows = visible(state);
  if (typeof args.index === "number") {
    const row = rows[args.index];
    return row ? state.notes.indexOf(row) : -1;
  }
  if (state.open) return state.notes.findIndex((n) => n.id === state.open);
  const row = rows[state.cursor];
  return row ? state.notes.indexOf(row) : -1;
}

function clampCursor(state: NotesState) {
  state.cursor = Math.max(0, Math.min(state.cursor, visible(state).length - 1));
}

/** Remember the current list so `undo` can put it back. */
function snapshot(state: NotesState) {
  state.history = [...state.history.slice(-(HISTORY_MAX - 1)), state.notes.map((n) => ({ ...n }))];
}

/** Put the cursor on a note, lifting the filter if it hides it. */
function reveal(state: NotesState, id: string) {
  let at = visible(state).findIndex((n) => n.id === id);
  if (at === -1) {
    state.query = ""; // a note you just wrote must not vanish behind a filter
    at = visible(state).findIndex((n) => n.id === id);
  }
  state.cursor = Math.max(0, at);
}

/** Write a note from `{title, body}` / `{text}` — the shape both callers send. */
function fromArgs(args: Record<string, unknown>): { title: string; body: string } | null {
  const blob = args.text ?? args.note ?? args.q;
  if (args.title === undefined && args.body === undefined && typeof blob === "string") return split(blob);
  if (args.title === undefined && args.body === undefined) return null;
  return { title: oneLine(args.title), body: asBody(args.body) };
}

export default defineApplet<NotesState>({
  id: "notes",
  title: "Notes",
  summary: "A notepad: titled, multi-line notes that survive restarts.",
  icon: "✎",
  tint: PAPER,
  labels: ["scratch"],
  initialState: { notes: [], cursor: 0, query: "", open: null, draft: null, history: [] },

  docs: {
    add: {
      doc: "Write a note. `{title, body}`, or `{text}` whose first line titles it. Newest first.",
      args: { title: "release plan", body: "cut rc1 friday\nfreeze monday" },
    },
    edit: {
      doc: "Rewrite a note, by `id` or `index`. Pass `title`/`body` to change it; pass neither to open the composer on it.",
      args: { id: "a1b2c3d4", body: "cut rc1 friday\nfreeze tuesday" },
    },
    open: { doc: "Read a note in full, by `id` or `index`.", args: { id: "a1b2c3d4" } },
    search: { doc: "Filter the list over titles and bodies. Empty `q` clears it.", args: { q: "release" } },
    compose: { doc: "Open the composer on a blank note (what `n` does).", args: {} },
    save: { doc: "Commit the open composer. `{value}` sets the field being edited first.", args: {} },
    remove: { doc: "Delete a note, by `id` or `index`. Undoable.", args: { id: "a1b2c3d4" } },
    clear: "Wipe the pad. Undoable.",
    undo: "Step back one mutation (add, edit, remove, clear).",
  },

  recipes: [
    {
      title: "Write a note and read it back",
      steps: [
        `kona call notes add '{"title":"release plan","body":"cut rc1 friday\\nfreeze monday"}'`,
        `kona call notes search '{"q":"release"}'`,
        "kona state notes",
      ],
      note: "add returns the note's id; `edit` and `open` take it as `{\"id\":\"…\"}`.",
    },
  ],

  verbs: {
    /**
     * Write a note. `{title, body}` from an agent, `{text}` from anything that
     * only has one string to give (a workflow step, the old one-line habit) —
     * its first line becomes the title and the rest the body.
     */
    add(args, { state, emit }) {
      const parsed = fromArgs(args) ?? { title: "", body: "" };
      if (!parsed.title && !parsed.body) return { added: false, reason: "empty note" };
      snapshot(state);
      const now = Date.now();
      const note: Note = { id: crypto.randomUUID().slice(0, 8), ...parsed, at: now, updated: now };
      state.notes.unshift(note);
      reveal(state, note.id);
      emit();
      return { added: true, id: note.id, title: heading(note.title, note.body), count: state.notes.length };
    },

    /**
     * With `title`/`body`/`text`: rewrite the note. With none of them: open the
     * composer on it — which is what `e` means, and what an agent can do to
     * hand a half-written note to the human at the keyboard.
     */
    edit(args, { state, emit }) {
      const i = indexOf(state, args);
      const target = state.notes[i];
      if (!target) return { error: "no such note" };
      const parsed = fromArgs(args);
      if (!parsed) {
        state.draft = { id: target.id, title: target.title, body: target.body, field: "title" };
        emit();
        return { composing: target.id };
      }
      if (!parsed.title && !parsed.body) return { error: "empty note" };
      snapshot(state);
      target.title = parsed.title;
      target.body = parsed.body;
      target.updated = Date.now();
      reveal(state, target.id);
      emit();
      return { id: target.id, title: heading(target.title, target.body), body: target.body };
    },

    /** Open the composer on a blank note. `n` at the keyboard. */
    compose(args, { state, emit }) {
      const seed = fromArgs(args) ?? { title: "", body: "" };
      state.draft = { id: null, ...seed, field: "title" };
      emit();
      return { composing: "new" };
    },

    /** A keystroke in the composer: keep state in step so tab can't lose text. */
    field(args, { state, emit }) {
      const d = state.draft;
      if (!d || typeof args.value !== "string") return { error: "not composing" };
      if (args.id === "note.body") d.body = args.value;
      else d.title = args.value;
      emit();
      return { ok: true };
    },

    /** Tab, and enter on the title: move the keyboard to the other field. */
    next(args, { state, emit }) {
      const d = state.draft;
      if (!d) return { error: "not composing" };
      if (typeof args.value === "string") {
        if (args.id === "note.body") d.body = args.value;
        else d.title = args.value;
      }
      d.field = d.field === "title" ? "body" : "title";
      emit();
      return { field: d.field };
    },

    /**
     * Commit the composer — ctrl+d in the body, or an agent finishing a note it
     * opened. Creates or updates, then leaves you reading what you wrote.
     */
    save(args, { state, emit }) {
      const d = state.draft;
      if (!d) return { error: "not composing" };
      if (typeof args.value === "string") {
        if (args.id === "note.body") d.body = args.value;
        else d.title = args.value;
      }
      const title = oneLine(d.title);
      const body = asBody(d.body);
      if (!title && !body) {
        state.draft = null;
        emit();
        return { saved: false, reason: "empty note" };
      }
      snapshot(state);
      const now = Date.now();
      const existing = d.id ? state.notes.find((n) => n.id === d.id) : undefined;
      const note: Note =
        existing ?? ({ id: crypto.randomUUID().slice(0, 8), at: now } as Note);
      note.title = title;
      note.body = body;
      note.updated = now;
      if (!existing) state.notes.unshift(note);
      state.draft = null;
      state.open = note.id;
      reveal(state, note.id);
      emit();
      return { saved: true, id: note.id, created: !existing, title: heading(title, body) };
    },

    /** Esc: close the composer, keeping the note as it was. */
    dismiss(_args, { state, emit }) {
      if (!state.draft) return { composing: false };
      state.draft = null;
      emit();
      return { composing: false };
    },

    /** Read a note in full (by index, id, or the selected row). */
    open(args, { state, emit }) {
      const i = indexOf(state, args);
      const target = state.notes[i];
      if (!target) return { error: "no such note" };
      state.open = target.id;
      reveal(state, target.id);
      emit();
      return { id: target.id, title: heading(target.title, target.body), body: target.body };
    },

    /** Back out one level: the open note, then the filter, then the launcher. */
    back(_args, { state, emit }) {
      if (state.open) state.open = null;
      else if (state.query) state.query = "";
      else return { at: "list" };
      clampCursor(state);
      emit();
      return { at: state.open ? "note" : "list" };
    },

    /** Filter over titles AND bodies. `/` at the keyboard; empty `q` clears. */
    search(args, { state, emit }) {
      state.query = oneLine(args.q ?? args.query);
      state.open = null;
      state.cursor = 0;
      emit();
      return { query: state.query, matched: visible(state).length };
    },

    /** Delete a note (by index, id, the open note, or the selected row). */
    remove(args, { state, emit }) {
      const i = indexOf(state, args);
      const target = state.notes[i];
      if (!target) return { error: "no such note" };
      snapshot(state);
      state.notes.splice(i, 1);
      if (state.open === target.id) state.open = null;
      clampCursor(state);
      emit();
      return { removed: heading(target.title, target.body), count: state.notes.length };
    },

    /** Wipe the pad. Undoable — the whole list comes back with `undo`. */
    clear(_args, { state, emit }) {
      if (!state.notes.length) return { cleared: 0 };
      snapshot(state);
      const n = state.notes.length;
      state.notes = [];
      state.cursor = 0;
      state.open = null;
      emit();
      return { cleared: n };
    },

    /** Step back one mutation (add, edit, remove, clear). */
    undo(_args, { state, emit }) {
      const prev = state.history.pop();
      if (!prev) return { undone: false };
      state.notes = prev;
      if (state.open && !state.notes.some((n) => n.id === state.open)) state.open = null;
      clampCursor(state);
      emit();
      return { undone: true, count: state.notes.length };
    },

    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(Math.max(0, visible(state).length - 1), state.cursor + 1);
      emit();
    },
  },

  /**
   * The pad that shipped before this one stored ONE collapsed line per note
   * (`{id, text, at}`). Those notes are on disk in real installs, so boot
   * migrates them rather than rendering `undefined` — the line becomes the
   * title, exactly as a one-line `add {"text":…}` does today.
   */
  init({ state, emit }) {
    let migrated = 0;
    for (const n of state.notes as Array<Note & { text?: string }>) {
      if (typeof n.title === "string" && typeof n.body === "string") continue;
      const { title, body } = split(typeof n.text === "string" ? n.text : "");
      n.title = title;
      n.body = body;
      n.updated ??= n.at;
      delete n.text;
      migrated++;
    }
    if (migrated) emit();
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "read",
    back: "back",
    backLabel: "list",
    canBack: (s) => !!s.open || !!s.query,
  },

  // A real search: it filters, it never creates. `n` is how a note is born.
  search: { verb: "search", placeholder: "filter notes (title, body)" },

  keymap: {
    n: { verb: "compose", label: "new" },
    e: { verb: "edit", label: "edit", when: (s) => s.notes.length > 0 },
    d: { verb: "remove", label: "delete", when: (s) => s.notes.length > 0 },
    u: { verb: "undo", label: "undo", when: (s) => s.history.length > 0 },
  },

  crumb: (s) => {
    const note = s.notes.find((n) => n.id === s.open);
    if (note) return heading(note.title, note.body);
    return s.query ? `“${s.query}”` : null;
  },

  accent: () => PAPER,

  // The composer: a title field and a real textarea, floating over the list.
  // Enter in the title moves to the body; in the body it is a NEWLINE, and
  // ctrl+d saves — which is the whole reason the editor grew a second shape.
  overlay: (state) => {
    const d = state.draft;
    if (!d) return null;
    const lines = d.body ? d.body.split("\n").length : 0;
    return {
      node: modal(
        d.id ? "edit note" : "new note",
        [
          labelled(
            "title",
            input("note.title", d.title, {
              placeholder: "what it's about",
              width: FIELD_W,
              focus: d.field === "title",
              submit: "next",
              submitLabel: "body",
              cancel: "dismiss",
              change: "field",
              color: PAPER,
            }),
            { labelWidth: 5 },
          ),
          spacer(),
          textarea("note.body", d.body, {
            placeholder: "write as much as you like — enter makes a new line",
            width: FIELD_W + 6,
            rows: BODY_ROWS,
            focus: d.field === "body",
            submit: "save",
            submitLabel: d.id ? "save" : "create",
            cancel: "dismiss",
            cancelLabel: "discard",
            change: "field",
            color: FG,
          }),
        ],
        {
          width: FORM_W,
          color: PAPER,
          footer: `tab switches field · ${lines} ${lines === 1 ? "line" : "lines"}`,
        },
      ),
      scrim: true,
      dismiss: "dismiss",
      keymap: { tab: { verb: "next", label: "next field" } },
    };
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const note = state.notes.find((n) => n.id === state.open);

    // --- Reading one note: the whole point of a body being multi-line.
    if (note) {
      const written = `written ${stamp(note.at)}`;
      const edited = note.updated > note.at ? ` · edited ${stamp(note.updated)}` : "";
      // A note is markdown: a heading is a heading and a `- ` is a bullet, but
      // `breaks` keeps a typed line a line — this is a notepad, not a blog.
      const body = renderMarkdown(note.body, { width: W - 1, breaks: true, color: FG });
      return [
        col([
          text(heading(note.title, note.body), { color: PAPER }),
          text(`${written}${edited}`, { color: DIM }),
          divider(W - 1),
          spacer(),
          ...(body.length ? body : [text("(no body — press e to write one)", { dim: true })]),
        ]),
      ];
    }

    // --- The list.
    const rows = visible(state);
    const count = `${rows.length} ${rows.length === 1 ? "note" : "notes"}`;
    const nodes: ViewNode[] = [
      row([
        text(`NOTEPAD  ·  ${count}`, { color: PAPER }),
        ...(state.query ? [text(`  matching “${state.query}”`, { color: DIM })] : []),
      ]),
      divider(W - 1),
    ];

    if (!rows.length) {
      nodes.push(
        spacer(),
        text(state.query ? `nothing matches “${state.query}”` : "no notes yet", { dim: true }),
        text(
          state.query ? "press esc to clear the filter" : "press n to write one · agents call notes.add",
          { color: DIM },
        ),
      );
      return [col(nodes)];
    }

    rows.forEach((n, i) => {
      const note = preview(n);
      nodes.push(
        recordRow(
          [
            { text: heading(n.title, n.body), width: Math.max(14, Math.floor((W - 16) * 0.4)) },
            { text: note, grow: true },
            { text: stamp(n.updated), width: 9, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: PAPER, color: FG, index: i },
        ),
      );
    });

    return [col(nodes)];
  },
});
