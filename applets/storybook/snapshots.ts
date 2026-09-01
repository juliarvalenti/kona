import { defineSnapshots } from "../../sdk/testing.ts";

/** The component gallery is the SDK's own regression test — every widget on screen. */
export default defineSnapshots([
  {
    name: "renders every component; bars fill mid-sweep",
    // Tall viewport: the gallery is longer than a default terminal, and every
    // component has to be on screen for this to be a real regression test.
    state: { frame: 45 },
    width: 62,
    height: 60,
    contains: [
      "kona components", "[LIVE]", "host", "inbox", "pause/resume",
      "█", // progress/gauge have fill at frame 45
      "▁", // sparkline's low samples
      "drafts", // tab strip
      "rate limited", // warn toast
      "─ cpu ─", // card's titled border
      "press m", // the modal lives on the overlay layer
    ],
    excludes: ["╔"], // ...so it is NOT drawn inline in the gallery
  },
  {
    name: "modal floats over the gallery as an overlay",
    state: { frame: 45, confirm: true },
    width: 62,
    height: 30,
    contains: [
      "delete draft?", // double-bordered dialog, centered
      "╔",
      "enter delete", // the overlay owns the hint bar
      "esc cancel",
    ],
    excludes: ["[LIVE]"], // scrim covers the body behind it
  },
  {
    name: "confirm verb leaves a transient toast in the body",
    state: { frame: 45, note: "draft deleted", noteUntil: 75 },
    width: 62,
    height: 30,
    contains: ["draft deleted", "kona components"], // no overlay: the body is back
  },
  {
    name: "an empty text field shows its placeholder",
    state: { frame: 0, name: "", editing: false },
    width: 62,
    height: 34,
    contains: ["type a name…"],
  },
  {
    name: "a filled text field shows the value instead",
    state: { frame: 0, name: "ada", editing: false },
    width: 62,
    height: 34,
    contains: ["ada", "hi, ada!"],
    excludes: ["type a name…"], // placeholder yields to the value
  },
]);
