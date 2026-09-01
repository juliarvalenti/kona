import {
  big,
  bigFits,
  col,
  defineApplet,
  fitBigFont,
  row,
  spacer,
  text,
  theme,
  type Color,
  type Theme,
  type ViewNode,
} from "../../sdk/index.ts";
import { divider } from "../../sdk/components.ts";
import { loadConfig, refreshConfig, writeThemePreset } from "../../core/config.ts";
import { THEME_PRESETS, resolvePreset, themePreset } from "../../core/themes.ts";

/**
 * theme — the palette picker. Arrow through the presets and the WHOLE UI
 * recolors AND re-letters under the cursor; enter writes the one it lands on
 * to `~/.config/kona/config.toml`, esc puts back what you had.
 *
 * A theme is colors and a display face: every preset ships a figlet
 * (`theme().font`), so the `kona` wordmark at the top of this screen is drawn
 * in the one under the cursor — the same font every hero in kona would then be
 * lettered in.
 *
 * The preview is not a trick of this applet's view: `theme(state)` (see the
 * applet ABI) hands the host a palette that stands in for the configured one
 * while this applet is open, so the frame, the hint bar and every other applet
 * drawn behind it recolor too — and leaving the applet drops the preview
 * without anything to clean up.
 *
 * Bimodal as always: `theme.preview {"preset":"nord"}` is what the ↓ key does
 * and `theme.set {"preset":"nord"}` is what enter does, so an agent retints the
 * human's terminal with the same two calls.
 */

interface ThemeState {
  /** Index into THEME_PRESETS — the row under the cursor, i.e. the PREVIEW. */
  cursor: number;
  /** The preset the config file currently holds. */
  applied: string;
  /** One line under the header: what the last call did, or what went wrong. */
  note: string | null;
}

/** The picker's own brand color in the launcher — Mocha's mauve. */
const TINT: Color = "#cba6f7";

const indexOf = (id: string) => Math.max(0, THEME_PRESETS.findIndex((p) => p.id === id));
const clamp = (i: number) => Math.min(THEME_PRESETS.length - 1, Math.max(0, i));
const at = (state: ThemeState) => THEME_PRESETS[clamp(state.cursor)]!;
const labelOf = (id: string) => themePreset(id)?.label ?? id;

/**
 * Re-read the config before answering: the file is the truth about what is
 * applied, and it can change without this applet (a hand edit, `kona theme
 * nord` in another terminal). One stat, and a parse only when it moved.
 */
function sync(state: ThemeState): void {
  refreshConfig();
  state.applied = loadConfig().preset;
}

/** `/home/you/.config/...` -> `~/.config/...`, so a note fits on one line. */
function tilde(path: string): string {
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The roles the config pins by hand — they win over every preset, so say so. */
function pinned(): (keyof Theme)[] {
  return Object.keys(loadConfig().themeOverrides) as (keyof Theme)[];
}

/**
 * The palette the cursor is previewing: the preset under it, with the roles the
 * config pins laid back on top — so what is on screen is exactly what `set`
 * would leave you with. Both the applet's `theme` hook (which hands it to the
 * host) and the view below read this one function.
 */
const preview = (s: ThemeState): Theme => ({ ...at(s).theme, ...loadConfig().themeOverrides });

export default defineApplet<ThemeState>({
  id: "theme",
  title: "Theme",
  summary: "Catppuccin, Nord, Dracula and friends — previewed live, saved on enter.",
  icon: "◐",
  tint: TINT,
  labels: ["appearance"],
  initialState: { cursor: 0, applied: "kona-aloha", note: null },

  docs: {
    list: "Every preset, its figlet, and which one is applied. Reads nothing else.",
    preview: {
      doc: "Show a preset in the running TUI — colors and figlet — without saving it. The same thing ↑↓ do; `theme.reset` (esc) puts the saved one back.",
      args: { preset: "nord" },
    },
    set: {
      doc: "Apply a preset and write it to ~/.config/kona/config.toml. Omit `preset` to keep the previewed one.",
      args: { preset: "catppuccin-mocha" },
    },
  },

  recipes: [
    {
      title: "Retint the human's terminal, then put it back",
      steps: [
        `kona call theme list`,
        `kona call theme preview '{"preset":"tokyo-night"}'`,
        `kona call theme set '{"preset":"tokyo-night"}'`,
        `kona call theme reset`,
      ],
      note: "preview is live but unsaved; set writes the config; reset returns to the saved preset.",
    },
  ],

  verbs: {
    /** The catalog — what an agent reads before choosing. Changes nothing. */
    list(_args, { state }) {
      sync(state);
      return {
        applied: state.applied,
        previewing: at(state).id,
        pinnedRoles: pinned(),
        presets: THEME_PRESETS.map((p) => ({ id: p.id, label: p.label, dark: p.dark, font: p.theme.font })),
      };
    },

    /** Move the cursor, which IS the preview — nothing is written. */
    preview(args, { state, emit }) {
      sync(state);
      const want = String(args.preset ?? args.name ?? args.theme ?? "");
      const id = resolvePreset(want);
      if (!id) {
        state.note = `no preset matches “${want}”`;
        emit();
        return { error: state.note };
      }
      state.cursor = indexOf(id);
      state.note = null;
      emit();
      return { previewing: id, font: preview(state).font, saved: false };
    },

    /** enter: keep what you are looking at. Writes the config file. */
    set(args, { state, emit }) {
      sync(state);
      const want = args.preset ?? args.name ?? args.theme;
      const id = want === undefined ? at(state).id : resolvePreset(String(want));
      if (!id) {
        state.note = `no preset matches “${String(want)}”`;
        emit();
        return { error: state.note };
      }
      let path: string;
      try {
        path = writeThemePreset(id);
      } catch (e) {
        state.note = `could not write the config: ${e instanceof Error ? e.message : String(e)}`;
        emit();
        return { error: state.note };
      }
      state.cursor = indexOf(id);
      state.applied = id;
      const also = pinned();
      state.note = also.length
        ? `saved ${labelOf(id)} — ${also.join(", ")} still come from your config`
        : `saved ${labelOf(id)} to ${tilde(path)}`;
      emit();
      return { applied: id, font: preview(state).font, path, saved: true };
    },

    /** esc: throw the preview away and go back to what is saved. */
    reset(_args, { state, emit }) {
      sync(state);
      state.cursor = indexOf(state.applied);
      state.note = null;
      emit();
      return { applied: state.applied };
    },

    up(_args, { state, emit }) {
      state.cursor = clamp(state.cursor - 1);
      state.note = null;
      emit();
    },

    down(_args, { state, emit }) {
      state.cursor = clamp(state.cursor + 1);
      state.note = null;
      emit();
    },
  },

  // The config is the truth, and it may have changed while the daemon was down
  // (or while another applet had the screen): open on the applied preset, so
  // the picker never boots previewing something you didn't pick.
  init({ state, emit }) {
    sync(state);
    state.cursor = indexOf(state.applied);
    state.note = null;
    emit();
  },

  cli: {
    usage: "kona theme [preset]   e.g. kona theme nord",
    open: (args) => (args.length ? { verb: "set", args: { preset: args.join(" ") } } : null),
  },

  nav: {
    up: "up",
    down: "down",
    select: "set",
    selectLabel: "save",
    // Browser-like: esc first drops an unsaved preview, and only then leaves.
    back: "reset",
    backLabel: "revert",
    canBack: (s) => at(s).id !== s.applied,
  },

  crumb: (s) => (at(s).id === s.applied ? null : "previewing"),

  // The frame tint follows the cursor, like everything else on screen.
  accent: (s) => at(s).theme.accent,

  /** The live preview — colors and figlet both. */
  theme: preview,

  view(state, ctx): ViewNode[] {
    // Two widths: the pane as the HOST sees it (what a hero is clamped
    // against) and the floor the list's own columns are laid out on.
    const pane = ctx?.width ?? 80;
    const W = Math.max(40, pane);
    const t = theme();
    const cur = at(state);
    const shown = preview(state);
    const dirty = cur.id !== state.applied;

    // The wordmark, drawn in the previewed preset's OWN figlet — the half of a
    // theme that colors can't show. It is also the honest sizing test: figlets
    // differ enough in size that one can overflow the pane, and what happens
    // here (fall back to the biggest that fits) is what happens to every hero
    // in kona, so the picker says so rather than letting you save a face that
    // gets quietly swapped out.
    const drawn = fitBigFont("kona", shown.font, { width: pane });
    const fits = bigFits("kona", shown.font, { width: pane });
    // The name column takes whatever the swatches and the sample don't: those
    // are fixed-width (10 cells of color, then Aa/code/dark), so a narrow
    // terminal clips the label rather than dropping the preview.
    const nameW = Math.min(30, Math.max(14, W - 34));

    const nodes: ViewNode[] = [
      big("kona", shown.accent, drawn),
      text(
        dirty
          ? `previewing ${cur.label} — enter keeps it, esc goes back to ${labelOf(state.applied)}`
          : `${cur.label} — every applet is drawn in it`,
        { color: dirty ? t.warn : t.fg },
      ),
      text(
        fits
          ? `${shown.font} — the figlet every hero is lettered in`
          : `${shown.font} — doesn't fit this pane; drawn in ${drawn}, as heroes would be`,
        fits ? { dim: true } : { color: t.warn },
      ),
      text(`${THEME_PRESETS.length} presets · ↑↓ previews live · enter saves · esc reverts`, { dim: true }),
    ];
    if (state.note) nodes.push(text(state.note, { color: state.note.startsWith("saved") ? t.ok : t.error }));
    nodes.push(divider(W - 1));

    // One row per preset, drawn in that preset's OWN colors: the list previews
    // before the cursor does, so you can skim it without arrowing through 21.
    THEME_PRESETS.forEach((p, i) => {
      const sel = i === state.cursor;
      const mark = p.id === state.applied ? "✓" : sel ? "▸" : " ";
      const label = ` ${mark} ${p.label}`.padEnd(nameW).slice(0, nameW);
      const swatch = (c: Color) => text("  ", { bg: c, index: i });
      nodes.push(
        row(
          [
            sel
              ? text(label, { color: p.theme.bg, bg: p.theme.accent, focus: true, index: i })
              : text(label, { color: p.theme.accent, index: i }),
            row([p.theme.accent, p.theme.alt, p.theme.ok, p.theme.warn, p.theme.error].map(swatch), { gap: 0 }),
            row(
              [
                text(" Aa ", { color: p.theme.fg, bg: p.theme.bg, index: i }),
                text(" code ", { color: p.theme.accent, bg: p.theme.field, index: i }),
                text(p.dark ? " dark " : " light ", { color: p.theme.dim, bg: p.theme.panel, index: i }),
              ],
              { gap: 0 },
            ),
          ],
          { gap: 1 },
        ),
      );
    });

    const also = pinned();
    if (also.length) {
      nodes.push(spacer());
      nodes.push(
        text(`${also.join(", ")} come from [theme] in your config and win over any preset`, { dim: true }),
      );
    }
    return [col(nodes)];
  },
});
