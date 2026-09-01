import { defineApplet, text, row, col, input, type ViewNode } from "../../sdk/index.ts";
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
}

const PURPLE = "#bb9af7";
const GREEN = "#00d488";
const BLUE = "#7aa2f7";
const AMBER = "#f0b000";

export default defineApplet<StoryState>({
  id: "storybook",
  title: "Storybook",
  summary: "Live gallery of kona components.",
  initialState: { frame: 0, name: "", editing: false },

  // Animating purely from the server tick proves the stream drives the UI.
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
    /** Esc drops the edit; state never saw the half-typed draft. */
    cancel: (_a, { state, emit }) => {
      state.editing = false;
      emit();
    },
  },
  keymap: { i: { verb: "edit", label: "edit name" } },
  tickMs: 100,
  tick({ state, emit }) {
    state.frame += 1;
    emit();
  },

  view(state) {
    const sweep = (state.frame % 100) / 100; // 0..1 looping

    // one labeled demo row: fixed-width dim label + the component, vertically centered
    const demo = (label: string, node: ViewNode): ViewNode =>
      row([text(label.padEnd(9), { dim: true }), node], { align: "center", gap: 1 });

    const section = (title: string, ...children: ViewNode[]): ViewNode =>
      col([heading(title), ...children], { gap: 0 });

    return [
      col(
        [
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
        ],
        { gap: 1 },
      ),
    ];
  },
});
