import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The picker draws every preset in its OWN colors, so these fixtures pin the
 * text around them: which row is ticked (applied), which is previewing, and
 * that the sample cells are on the row.
 */
export default defineSnapshots([
  {
    name: "previewing a preset marks the row and says what enter would keep",
    // Catppuccin Mocha, with kona's own palette still the saved one.
    state: { cursor: 4, applied: "kona-aloha", note: null },
    width: 80,
    height: 24,
    contains: [
      "previewing Catppuccin Mocha",
      "✓ kona aloha",
      "▸ Catppuccin Mocha",
      "Nord",
      "Dracula",
      "code", // the per-row mini sample
    ],
  },
  {
    name: "with nothing previewed the applied preset is simply ticked",
    state: { cursor: 0, applied: "kona-aloha", note: null },
    width: 72,
    height: 20,
    contains: ["every applet is drawn in it", "✓ kona aloha"],
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
