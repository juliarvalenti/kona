import { defineApplet, text, row, col, input, theme, type ViewNode } from "../../sdk/index.ts";
import {
  progress,
  gauge,
  spinner,
  badge,
  keyValue,
  list,
  table,
  divider,
  field,
  heading,
  sparkline,
  tabs,
  toast,
  card,
  modal,
} from "../../sdk/components.ts";

/**
 * storybook — a live gallery of every kona component. It also dogfoods the
 * whole platform: most of it animates without anyone touching a key, because
 * the daemon ticks `frame` every 100ms and streams it over SSE to the TUI. If
 * the spinner spins and the bars sweep, the server->stream->render loop is
 * alive.
 *
 * The name field is the counter-proof, in the other direction: press `i` and
 * type, or — with no terminal open at all — run
 *
 *   kona call storybook save '{"value":"ada"}'
 *
 * Same verb, same state, same repaint. A text field is just another view node.
 */

interface StoryState {
  frame: number;
  /** The text field's value. State owns it, so an agent can set it too. */
  name: string;
  /** ...and state owns the focus, so an agent can open the editor too. */
  editing: boolean;
  /** Is the demo confirm dialog up? Drives the overlay. */
  confirm: boolean;
  /** Transient banner text, cleared by the tick. */
  note: string | null;
  noteUntil: number;
}

/** A rolling series for the sparkline demo — a sine wave sampled per frame. */
function series(frame: number, n = 24): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin((frame + i) / 3) + Math.sin((frame + i) / 7));
}

export default defineApplet<StoryState>({
  id: "storybook",
  title: "Storybook",
  summary: "Live gallery of kona components.",
  icon: "✦",
  tint: "#ff79c6", // gallery pink
  labels: ["dev"],
  initialState: { frame: 0, name: "", editing: false, confirm: false, note: null, noteUntil: 0 },

  // Every verb is bimodal: a keypress fires it and so does `kona call storybook
  // <verb>`. The text field and the confirm dialog both demonstrate that seam.
  docs: {
    edit: "Give the demo text field the keyboard (state owns the focus).",
    save: { doc: "Commit a value into the field — what `enter` does for a human.", args: { value: "ada" } },
    ask: "Raise the confirm dialog (the overlay demo).",
    ok: "Confirm the dialog.",
    cancel: "Drop the edit and dismiss the dialog.",
  },

  verbs: {
    /** Give the field the keyboard. */
    edit: (_a, { state, emit }) => {
      state.editing = true;
      emit();
    },
    /** Enter (or an agent) commits the value. */
    save: (args, { state, emit }) => {
      if (typeof args.value === "string") state.name = args.value;
      state.editing = false;
      emit();
    },
    /** Open the confirm dialog (the overlay). */
    ask: (_a, { state, emit }) => {
      state.confirm = true;
      emit();
    },
    /** Confirm the dialog's action, leaving a transient toast behind. */
    ok: (_a, { state, emit }) => {
      state.confirm = false;
      state.note = "draft deleted";
      state.noteUntil = state.frame + 30; // ~3s at tickMs 100
      emit();
    },
    /** Esc: drop the edit AND dismiss the dialog (input cancel + overlay dismiss). */
    cancel: (_a, { state, emit }) => {
      state.editing = false;
      state.confirm = false;
      emit();
    },
  },
  keymap: { i: { verb: "edit", label: "edit name" }, m: { verb: "ask", label: "modal" } },

  // A floating confirm dialog over the gallery — the overlay seam itself.
  overlay: (state) =>
    state.confirm
      ? {
          node: modal("delete draft?", [text("This can't be undone.")], { width: 34 }),
          scrim: true,
          confirm: "ok",
          confirmLabel: "delete",
          dismiss: "cancel",
        }
      : null,

  // Animating purely from the server tick proves the stream drives the UI.
  tickMs: 100,
  tick({ state, emit }) {
    state.frame += 1;
    if (state.note && state.frame > state.noteUntil) state.note = null;
    emit();
  },

  view(state) {
    const sweep = (state.frame % 100) / 100; // 0..1 looping
    // Straight from the central theme — recolor config.toml and the gallery
    // recolors with it.
    const { alt: PURPLE, ok: GREEN, accent: BLUE, warn: AMBER } = theme();

    // one labeled demo row: fixed-width dim label + the component, vertically centered
    const demo = (label: string, node: ViewNode): ViewNode =>
      row([text(label.padEnd(9), { dim: true }), node], { align: "center", gap: 1 });

    const section = (title: string, ...children: ViewNode[]): ViewNode =>
      col([heading(title), ...children], { gap: 0 });

    return [
      col(
        [
          // A real transient banner: `ok` sets it, the tick clears it.
          ...(state.note ? [toast(state.note, "info")] : []),
          heading("kona components", PURPLE),
          divider(40),
          col(
            [
              demo("progress", progress(sweep, { width: 22, color: GREEN })),
              demo("gauge", gauge(sweep, { width: 16, color: BLUE })),
              demo("spinner", spinner(state.frame, AMBER)),
              demo("badge", badge("LIVE", GREEN)),
            ],
            { gap: 0 },
          ),
          section(
            "input",
            field(
              "name",
              input("name", state.name, {
                placeholder: "type a name…",
                width: 26,
                focus: state.editing,
                submit: "save",
                cancel: "cancel",
                color: GREEN,
              }),
              { labelWidth: 7 },
            ),
            field("hello", text(state.name ? `hi, ${state.name}!` : "—", { dim: !state.name }), {
              labelWidth: 7,
            }),
          ),
          section("sparkline", sparkline(series(state.frame), { color: GREEN })),
          section("tabs", tabs(["inbox", "sent", "drafts"], Math.floor(state.frame / 20) % 3, { accent: PURPLE })),
          section("toast", toast("saved", "info"), toast("rate limited", "warn"), toast("auth failed", "error")),
          section("keyValue", keyValue("host", "localhost:4177", { color: BLUE })),
          section("list", ...list(["inbox", "calendar", "timer"], { cursor: state.frame % 3, color: PURPLE })),
          section(
            "table",
            ...table(
              ["key", "does"],
              [
                ["space", "pause/resume"],
                ["a", "+1m"],
                ["s", "stop"],
              ],
            ),
          ),
          section(
            "card",
            card("cpu", [gauge(sweep, { width: 14, color: GREEN }), sparkline(series(state.frame, 14), { color: GREEN })], {
              color: GREEN,
              width: 24,
            }),
          ),
          // The modal is NOT drawn inline: it's an overlay, so it floats over
          // this gallery instead of taking a slot in it.
          section("modal", text("press m — floats over the body", { dim: true })),
        ],
        { gap: 1 },
      ),
    ];
  },
});
