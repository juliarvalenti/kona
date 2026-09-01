import { defineApplet, text, row, col, type ViewNode } from "../../sdk/index.ts";
import {
  progress,
  gauge,
  spinner,
  badge,
  keyValue,
  list,
  table,
  divider,
  heading,
} from "../../sdk/components.ts";

/**
 * storybook — a live gallery of every kona component. It also dogfoods the
 * whole platform: nothing here is interactive, yet it animates, because the
 * daemon ticks `frame` every 100ms and streams it over SSE to the TUI. If the
 * spinner spins and the bars sweep, the server->stream->render loop is alive.
 */

interface StoryState {
  frame: number;
}

const PURPLE = "#bb9af7";
const GREEN = "#00d488";
const BLUE = "#7aa2f7";
const AMBER = "#f0b000";

export default defineApplet<StoryState>({
  id: "storybook",
  title: "Storybook",
  summary: "Live gallery of kona components.",
  initialState: { frame: 0 },

  // Animating purely from the server tick proves the stream drives the UI.
  verbs: {},
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
