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
import { loadConfig, refreshConfig, writeTheme } from "../../core/config.ts";
import { BIG_FONTS, DEFAULT_FONT, isBigFont, resolveBigFont, type BigFont } from "../../core/fonts.ts";
import { THEME_PRESETS, resolvePreset, themePreset } from "../../core/themes.ts";

/**
 * theme — the appearance picker, on TWO axes. Arrow through the palettes and
 * the whole UI recolors under the cursor; `tab` hands the arrows to the figlet
 * list and the same keys re-letter every hero instead. Enter writes the combo
 * you are looking at to `~/.config/kona/config.toml`, esc puts back what you
 * had.
 *
 * The second axis is the point. A theme is colors AND a display face, and every
 * preset ships a figlet (`theme().font`) — but a preset's face is a suggestion,
 * not a package deal: the config has always been able to say "Nord, but the
 * `slick` letters", and this is where that stops being a hand-edited file. The
 * two compose live, so the `kona` wordmark at the top of this screen is the
 * exact combination `enter` would save.
 *
 * The figlet list opens on `auto`, which is the row that means "whatever the
 * palette brings" — so arrowing through presets still re-letters, the way it
 * always did, and a face is only pinned in the config once you deliberately
 * pick one.
 *
 * The preview is not a trick of this applet's view: `theme(state)` (see the
 * applet ABI) hands the host a palette that stands in for the configured one
 * while this applet is open, so the frame, the hint bar and every other applet
 * drawn behind it recolor too — and leaving the applet drops the preview
 * without anything to clean up.
 *
 * Bimodal as always: `theme.preview {"preset":"nord","font":"huge"}` is what
 * the arrows do and `theme.set` is what enter does, with `theme.font
 * {"font":"huge"}` for the face alone — so an agent retints and re-letters the
 * human's terminal with the same calls their fingers make.
 */

interface ThemeState {
  /** Index into THEME_PRESETS — the row under the cursor, i.e. the PREVIEW. */
  cursor: number;
  /** Index into FONT_ROWS — the face under the cursor. Row 0 is `auto`. */
  fontCursor: number;
  /** Which of the two lists ↑↓ moves. `tab` swaps it. */
  axis: Axis;
  /** The preset the config file currently holds. */
  applied: string;
  /** The face in force: the pinned one, else the applied preset's own. */
  appliedFont: BigFont;
  /** The face the config PINS, if any — null means it follows the preset. */
  pinnedFont: BigFont | null;
  /** One line under the header: what the last call did, or what went wrong. */
  note: string | null;
}

/** The two selectable lists: the colors, and the letters. */
type Axis = "palette" | "font";

/**
 * The figlet list, with `auto` — no pin, follow the palette — as its first row.
 * Having a row for "no choice" is what keeps a mix-and-match picker from
 * pinning a face into everyone's config the first time they change palette.
 */
const FONT_ROWS: (BigFont | null)[] = [null, ...BIG_FONTS];

/** The picker's own brand color in the launcher — Mocha's mauve. */
const TINT: Color = "#cba6f7";

/**
 * A click carries one flat row number across the whole screen (that is all a
 * mouse gives us), so the figlet rows are numbered after the last palette row.
 */
const FONT_BASE = THEME_PRESETS.length;

const indexOf = (id: string) => Math.max(0, THEME_PRESETS.findIndex((p) => p.id === id));
const clamp = (i: number) => Math.min(THEME_PRESETS.length - 1, Math.max(0, i || 0));
const at = (state: ThemeState) => THEME_PRESETS[clamp(state.cursor)]!;
const labelOf = (id: string) => themePreset(id)?.label ?? id;

const clampFont = (i: number) => Math.min(FONT_ROWS.length - 1, Math.max(0, i || 0));
const fontRowOf = (font: BigFont | null) => Math.max(0, FONT_ROWS.indexOf(font));
/** The face the font cursor names, or null while it sits on `auto`. */
const choice = (state: ThemeState): BigFont | null => FONT_ROWS[clampFont(state.fontCursor)] ?? null;
/** The figlet a preset brings with it — what `auto` resolves to. */
const fontOf = (id: string) => themePreset(id)?.theme.font ?? DEFAULT_FONT;
/** The face actually on screen: the pick, or the previewed preset's own. */
const shownFont = (state: ThemeState): BigFont => choice(state) ?? fontOf(at(state).id);

/**
 * Re-read the config before answering: the file is the truth about what is
 * applied, and it can change without this applet (a hand edit, `kona theme
 * nord` in another terminal). One stat, and a parse only when it moved.
 */
function sync(state: ThemeState): void {
  refreshConfig();
  const cfg = loadConfig();
  state.applied = cfg.preset;
  state.appliedFont = cfg.theme.font;
  state.pinnedFont = cfg.themeOverrides.font ?? null;
}

/** `/home/you/.config/...` -> `~/.config/...`, so a note fits on one line. */
function tilde(path: string): string {
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * The COLOR roles the config pins by hand — they win over every preset, so say
 * so. `font` is not one of them any more: it is an axis of this picker, which
 * writes it, so a pinned face is something you are steering rather than
 * something quietly overriding you.
 */
function pinned(): Exclude<keyof Theme, "font">[] {
  return Object.keys(loadConfig().themeOverrides).filter((r) => r !== "font") as Exclude<
    keyof Theme,
    "font"
  >[];
}

/**
 * The palette the two cursors are previewing: the preset under one, the face
 * under the other, with the color roles the config pins laid back on top — so
 * what is on screen is exactly what `set` would leave you with. Both the
 * applet's `theme` hook (which hands it to the host) and the view below read
 * this one function.
 */
function preview(state: ThemeState): Theme {
  const { font: _pin, ...colors } = loadConfig().themeOverrides;
  return { ...at(state).theme, ...colors, font: shownFont(state) };
}

/** Is either cursor somewhere other than what the config holds? */
const dirty = (s: ThemeState) =>
  at(s).id !== s.applied || shownFont(s) !== s.appliedFont || choice(s) !== (s.pinnedFont ?? null);

/** Read an axis name off a verb's args. Null when it isn't one. */
function readAxis(want: unknown): Axis | null {
  const q = String(want).trim().toLowerCase();
  if (/^(palette|preset|presets|colors?|colours?)$/.test(q)) return "palette";
  if (/^(font|fonts|figlet|figlets|face)$/.test(q)) return "font";
  return null;
}

/**
 * A figlet argument: a face's name, or `auto` (also `preset`, `none`, `null`)
 * for the row that follows the palette. `undefined` means it matched nothing —
 * a caller's typo, never a silent guess.
 */
function readFont(want: unknown): BigFont | null | undefined {
  if (want === null) return null;
  const q = String(want).trim().toLowerCase();
  if (/^(auto|preset|none|null|)$/.test(q)) return null;
  return resolveBigFont(q) ?? undefined;
}

/**
 * A click carries the row it landed on and nothing else, so `set` resolves it
 * to a cursor first: clicking a figlet picks that face, clicking a palette row
 * picks that palette, and either way the focus follows your hand.
 */
function pickIndex(state: ThemeState, raw: unknown): void {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return;
  if (raw >= FONT_BASE) {
    state.fontCursor = clampFont(raw - FONT_BASE);
    state.axis = "font";
  } else {
    state.cursor = clamp(raw);
    state.axis = "palette";
  }
}

/**
 * Write a combo and record what happened. `auto` writes no `font` line at all
 * (and clears one that was there), so a config only carries a face when you
 * asked for one that the palette wouldn't have brought.
 */
function save(state: ThemeState, id: string, font: BigFont | null): { path?: string; error?: string } {
  let path: string;
  try {
    path = writeTheme({ preset: id, font });
  } catch (e) {
    state.note = `could not write the config: ${e instanceof Error ? e.message : String(e)}`;
    return { error: state.note };
  }
  state.cursor = indexOf(id);
  state.fontCursor = fontRowOf(font);
  state.applied = id;
  state.pinnedFont = font;
  state.appliedFont = font ?? fontOf(id);
  const also = pinned();
  const what = `${labelOf(id)} · ${state.appliedFont}${font ? "" : " (its own)"}`;
  state.note = also.length
    ? `saved ${what} — ${also.join(", ")} still come from your config`
    : `saved ${what} to ${tilde(path)}`;
  return { path };
}

/** ↑↓ move the cursor of whichever list has focus — that is all `tab` does. */
function move(state: ThemeState, delta: number): void {
  if (state.axis === "font") state.fontCursor = clampFont(state.fontCursor + delta);
  else state.cursor = clamp(state.cursor + delta);
  state.note = null;
}

export default defineApplet<ThemeState>({
  id: "theme",
  title: "Theme",
  summary: "Catppuccin, Nord, Dracula and friends — any palette, any figlet, previewed live.",
  icon: "◐",
  tint: TINT,
  labels: ["appearance"],
  initialState: {
    cursor: 0,
    fontCursor: 0,
    axis: "palette",
    applied: "kona-aloha",
    appliedFont: DEFAULT_FONT,
    pinnedFont: null,
    note: null,
  },

  docs: {
    list: "Every preset and every figlet, and which of each is applied. Reads nothing else.",
    preview: {
      doc: "Show a palette and/or a figlet in the running TUI without saving it. The same thing the arrows do; `theme.reset` (esc) puts the saved combo back.",
      args: { preset: "nord", font: "huge" },
    },
    set: {
      doc: "Apply a combo and write it to ~/.config/kona/config.toml. Omit either key to keep what is previewed; `font: \"auto\"` pins none, leaving the face to the preset.",
      args: { preset: "nord", font: "huge" },
    },
    font: {
      doc: "Change just the display face, keeping the palette that is applied. Names are fuzzy (`hug` is `huge`), and `auto` hands the face back to the preset.",
      args: { font: "huge" },
    },
    focus: {
      doc: "Which list the arrows move — `palette` or `font`. What `tab` does; omit `axis` to toggle.",
      args: { axis: "font" },
    },
    reset: "Drop both previews and go back to the saved combo (esc).",
  },

  recipes: [
    {
      title: "Mix a palette with a figlet that isn't its own",
      steps: [
        `kona call theme list`,
        `kona call theme preview '{"preset":"nord","font":"huge"}'`,
        `kona call theme set '{"preset":"nord","font":"huge"}'`,
        `kona call theme font '{"font":"auto"}'`,
        `kona call theme reset`,
      ],
      note: "preview is live but unsaved; set writes the combo; font changes the face alone (`auto` gives it back to the palette); reset returns to what is saved.",
    },
  ],

  verbs: {
    /** The catalog — what an agent reads before choosing. Changes nothing. */
    list(_args, { state }) {
      sync(state);
      return {
        applied: state.applied,
        appliedFont: state.appliedFont,
        pinnedFont: state.pinnedFont,
        previewing: at(state).id,
        previewingFont: shownFont(state),
        axis: state.axis,
        pinnedRoles: pinned(),
        presets: THEME_PRESETS.map((p) => ({ id: p.id, label: p.label, dark: p.dark, font: p.theme.font })),
        fonts: BIG_FONTS.map((f) => ({ id: f, presets: THEME_PRESETS.filter((p) => p.theme.font === f).length })),
      };
    },

    /** Move either cursor, which IS the preview — nothing is written. */
    preview(args, { state, emit }) {
      sync(state);
      const wantPreset = args.preset ?? args.name ?? args.theme;
      const wantFont = args.font ?? args.face;
      if (wantPreset === undefined && wantFont === undefined) {
        state.note = "preview takes a preset, a font, or both";
        emit();
        return { error: state.note };
      }
      if (wantPreset !== undefined) {
        const id = resolvePreset(String(wantPreset));
        if (!id) {
          state.note = `no preset matches “${String(wantPreset)}”`;
          emit();
          return { error: state.note };
        }
        state.cursor = indexOf(id);
        state.axis = "palette";
      }
      if (wantFont !== undefined) {
        const font = readFont(wantFont);
        if (font === undefined) {
          state.note = `no figlet matches “${String(wantFont)}” (have: ${BIG_FONTS.join(", ")}, auto)`;
          emit();
          return { error: state.note };
        }
        state.fontCursor = fontRowOf(font);
        state.axis = "font";
      }
      state.note = null;
      emit();
      return { previewing: at(state).id, font: shownFont(state), pinning: choice(state), saved: false };
    },

    /** enter: keep the combo you are looking at. Writes the config file. */
    set(args, { state, emit }) {
      sync(state);
      pickIndex(state, args.index);
      const wantPreset = args.preset ?? args.name ?? args.theme;
      const id = wantPreset === undefined ? at(state).id : resolvePreset(String(wantPreset));
      if (!id) {
        state.note = `no preset matches “${String(wantPreset)}”`;
        emit();
        return { error: state.note };
      }
      const wantFont = args.font ?? args.face;
      const font = wantFont === undefined ? choice(state) : readFont(wantFont);
      if (font === undefined) {
        state.note = `no figlet matches “${String(wantFont)}” (have: ${BIG_FONTS.join(", ")}, auto)`;
        emit();
        return { error: state.note };
      }
      const written = save(state, id, font);
      emit();
      return written.error
        ? written
        : { applied: id, font: state.appliedFont, pinned: font, path: written.path, saved: true };
    },

    /**
     * The face alone: keep whatever palette is applied and re-letter. The
     * second axis as one call, for a caller that only cares about the letters.
     */
    font(args, { state, emit }) {
      sync(state);
      const want = args.font ?? args.face ?? args.name;
      const font = want === undefined ? choice(state) : readFont(want);
      if (font === undefined) {
        state.note = `no figlet matches “${String(want)}” (have: ${BIG_FONTS.join(", ")}, auto)`;
        emit();
        return { error: state.note };
      }
      const written = save(state, state.applied, font);
      emit();
      return written.error
        ? written
        : { applied: state.applied, font: state.appliedFont, pinned: font, path: written.path, saved: true };
    },

    /** tab: hand the arrows to the other list. */
    focus(args, { state, emit }) {
      const want = args.axis ?? args.on ?? args.list;
      const axis = want === undefined ? (state.axis === "palette" ? "font" : "palette") : readAxis(want);
      if (!axis) {
        state.note = `no such list “${String(want)}” — palette or font`;
        emit();
        return { error: state.note };
      }
      state.axis = axis;
      state.note = null;
      emit();
      return { axis };
    },

    /** esc: throw both previews away and go back to what is saved. */
    reset(_args, { state, emit }) {
      sync(state);
      state.cursor = indexOf(state.applied);
      state.fontCursor = fontRowOf(state.pinnedFont);
      state.note = null;
      emit();
      return { applied: state.applied, font: state.appliedFont };
    },

    up(_args, { state, emit }) {
      move(state, -1);
      emit();
    },

    down(_args, { state, emit }) {
      move(state, 1);
      emit();
    },
  },

  // The config is the truth, and it may have changed while the daemon was down
  // (or while another applet had the screen): open on the applied combo, so the
  // picker never boots previewing something you didn't pick.
  init({ state, emit }) {
    sync(state);
    state.cursor = indexOf(state.applied);
    state.fontCursor = fontRowOf(state.pinnedFont);
    state.axis = "palette";
    state.note = null;
    emit();
  },

  cli: {
    usage: "kona theme [preset] [figlet]   e.g. kona theme nord huge, or kona theme tiny",
    // A trailing figlet name is the second axis on the command line. Matched
    // exactly, never fuzzily, so a preset whose name merely looks font-ish is
    // still read as a preset.
    open: (args) => {
      if (!args.length) return null;
      const tail = args[args.length - 1]!.trim().toLowerCase();
      const font = isBigFont(tail) || tail === "auto" ? tail : null;
      const rest = font ? args.slice(0, -1) : args;
      if (!rest.length) return font ? { verb: "font", args: { font } } : null;
      return { verb: "set", args: { preset: rest.join(" "), ...(font ? { font } : {}) } };
    },
  },

  keymap: {
    tab: { verb: "focus", label: "palette/figlet" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "set",
    selectLabel: "save",
    // Browser-like: esc first drops an unsaved preview, and only then leaves.
    back: "reset",
    backLabel: "revert",
    canBack: dirty,
  },

  crumb: (s) => (dirty(s) ? "previewing" : null),

  // The frame tint follows the cursor, like everything else on screen.
  accent: (s) => at(s).theme.accent,

  /** The live preview — the palette from one list, the figlet from the other. */
  theme: preview,

  view(state, ctx): ViewNode[] {
    // Two widths: the pane as the HOST sees it (what a hero is clamped
    // against) and the floor the list's own columns are laid out on.
    const pane = ctx?.width ?? 80;
    const W = Math.max(40, pane);
    const t = theme();
    const cur = at(state);
    const shown = preview(state);
    const font = shown.font;
    const moved = dirty(state);

    // The wordmark, drawn in the previewed COMBO — the color from one list, the
    // letters from the other. It is also the honest sizing test: figlets differ
    // enough in size that one can overflow the pane, and what happens here
    // (fall back to the biggest that fits) is what happens to every hero in
    // kona, so the picker says so rather than letting you save a face that gets
    // quietly swapped out.
    const drawn = fitBigFont("kona", font, { width: pane });
    const fits = bigFits("kona", font, { width: pane });
    // The figlet column is fixed (its longest name is `pallet`); the per-row
    // color sample is the first thing a narrow pane gives up, since the
    // swatches beside it already say what the palette looks like; and the name
    // column takes what is left, clipping rather than dropping.
    const sample = W >= 62;
    const nameW = Math.min(30, Math.max(12, W - (sample ? 45 : 28)));

    const nodes: ViewNode[] = [
      big("kona", shown.accent, drawn),
      text(
        moved
          ? `previewing ${cur.label} · ${font} — enter keeps it, esc reverts`
          : `${cur.label} · ${font} — every applet is drawn in it`,
        { color: moved ? t.warn : t.fg },
      ),
      text(
        fits
          ? `${font} — the figlet every hero is lettered in`
          : `${font} — doesn't fit this pane; drawn in ${drawn}, as heroes would be`,
        fits ? { dim: true } : { color: t.warn },
      ),
      text(`${THEME_PRESETS.length} palettes × ${BIG_FONTS.length} figlets · tab switches list · enter saves`, {
        dim: true,
      }),
    ];
    if (state.note) nodes.push(text(state.note, { color: state.note.startsWith("saved") ? t.ok : t.error }));
    nodes.push(divider(W - 1));

    // One row per preset, drawn in that preset's OWN colors: the list previews
    // before the cursor does, so you can skim it without arrowing through 21.
    const palette: ViewNode[] = [heading(" palette", state.axis === "palette", t)];
    THEME_PRESETS.forEach((p, i) => {
      const sel = i === state.cursor;
      const live = sel && state.axis === "palette";
      const mark = p.id === state.applied ? "✓" : sel ? "▸" : " ";
      const label = ` ${mark} ${p.label}`.padEnd(nameW).slice(0, nameW);
      const swatch = (c: Color) => text("  ", { bg: c, index: i });
      palette.push(
        row(
          [
            // The selection is a filled bar while this list has the arrows, and
            // a quieter trough while the other one does — so which cursor a
            // keypress would move is never a guess.
            live
              ? text(label, { color: p.theme.bg, bg: p.theme.accent, focus: true, index: i })
              : text(label, { color: p.theme.accent, ...(sel ? { bg: p.theme.field } : {}), index: i }),
            row([p.theme.accent, p.theme.alt, p.theme.ok, p.theme.warn, p.theme.error].map(swatch), { gap: 0 }),
            ...(sample
              ? [
                  row(
                    [
                      text(" Aa ", { color: p.theme.fg, bg: p.theme.bg, index: i }),
                      text(" code ", { color: p.theme.accent, bg: p.theme.field, index: i }),
                      text(p.dark ? " dark " : " light ", { color: p.theme.dim, bg: p.theme.panel, index: i }),
                    ],
                    { gap: 0 },
                  ),
                ]
              : []),
          ],
          { gap: 1 },
        ),
      );
    });

    // ...and one row per figlet, the second axis, with `auto` on top: that row
    // is "whatever the palette brings", which is what a config with no `font`
    // line means. A face too wide for this pane is dimmed — you can still pick
    // it (heroes fall back), but the list says which ones this terminal shows
    // as drawn.
    const faces: ViewNode[] = [heading(" figlet", state.axis === "font", t)];
    FONT_ROWS.forEach((f, i) => {
      const sel = i === state.fontCursor;
      const live = sel && state.axis === "font";
      const mark = f === (state.pinnedFont ?? null) ? "✓" : sel ? "▸" : " ";
      const label = ` ${mark} ${f ?? "auto"}`.padEnd(9);
      const tooWide = f !== null && !bigFits("kona", f, { width: pane });
      faces.push(
        live
          ? text(label, { color: t.bg, bg: t.accent, focus: true, index: FONT_BASE + i })
          : text(label, {
              color: sel ? t.accent : tooWide ? t.muted : t.fg,
              ...(sel ? { bg: t.field } : {}),
              dim: tooWide && !sel,
              index: FONT_BASE + i,
            }),
      );
    });

    nodes.push(row([col(palette), col(faces)], { gap: 2 }));

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

/** A column's title, filled in when its list is the one the arrows move. */
function heading(label: string, active: boolean, t: Theme): ViewNode {
  return active ? text(`${label} `, { color: t.bg, bg: t.accent }) : text(`${label} `, { dim: true });
}
