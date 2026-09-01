import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The picker draws every preset in its OWN colors, so these fixtures pin the
 * text around them: which row is ticked (applied), which is previewing, that
 * the sample cells are on the row — and the figlet line, which is the half of
 * a theme the colors can't show in plain text.
 */
export default defineSnapshots([
  {
    name: "previewing a preset marks the row and says what enter would keep",
    // Catppuccin Mocha, with kona's own palette still the saved one.
    state: { cursor: 4, applied: "kona-aloha", note: null },
    width: 80,
    // Tall enough for the wordmark AND a few rows of the list under it: the
    // hero is a preview, not the screen.
    height: 30,
    contains: [
      "previewing Catppuccin Mocha",
      "✓ kona aloha",
      "▸ Catppuccin Mocha",
      "Nord",
      "Dracula",
      "code", // the per-row mini sample
      "slick — the figlet every hero is lettered in",
    ],
  },
  {
    // Dracula letters in `huge`, which wants 50 cells for "kona" — more than
    // this pane has. The picker says so instead of pretending it saved a face
    // you'd never actually see.
    name: "a figlet too big for the pane is named, and the fallback with it",
    state: { cursor: 6, applied: "kona-aloha", note: null },
    width: 56,
    height: 24,
    contains: ["previewing Dracula", "huge — doesn't fit this pane; drawn in"],
  },
  {
    name: "with nothing previewed the applied preset is simply ticked",
    state: { cursor: 0, applied: "kona-aloha", note: null },
    width: 72,
    height: 20,
    contains: ["every applet is drawn in it", "✓ kona aloha", "block — the figlet"],
    excludes: ["previewing"],
  },
  {
    name: "a save says what it wrote",
    state: { cursor: 5, applied: "nord", note: "saved Nord to ~/.config/kona/config.toml" },
    width: 72,
    height: 20,
    contains: ["saved Nord to ~/.config/kona/config.toml", "✓ Nord"],
  },
]);
