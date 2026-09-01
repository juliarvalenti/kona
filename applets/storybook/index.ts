import { defineApplet, text, spacer, row } from "../../sdk/index.ts";
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

    return [
      heading("kona components", PURPLE),
      divider(36),
      spacer(),
      row(text("progress  ", { dim: true }), progress(sweep, { width: 22, color: GREEN })),
      row(text("gauge     ", { dim: true }), gauge(sweep, { width: 16, color: BLUE })),
      row(text("spinner   ", { dim: true }), spinner(state.frame, AMBER)),
      row(text("badge     ", { dim: true }), badge("LIVE", GREEN)),
      spacer(),
      heading("keyValue"),
      keyValue("host", "localhost:4177", { color: BLUE }),
      spacer(),
      heading("list"),
      ...list(["inbox", "calendar", "timer"], { cursor: state.frame % 3, color: PURPLE }),
      spacer(),
      heading("table"),
      ...table(
        ["key", "does"],
        [
          ["space", "pause/resume"],
          ["a", "+1m"],
          ["s", "stop"],
        ],
      ),
    ];
  },
});
