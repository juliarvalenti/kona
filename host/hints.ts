import { bold, fg, type TextChunk } from "@opentui/core";
import {
  bindingFor,
  normalizeBinding,
  type AppletDef,
  type AppletState,
  type Color,
  type InputNode,
  type Overlay,
} from "../sdk/index.ts";

/**
 * The hint bar — the line under the frame that says what the keys do right now.
 *
 * It is a rendering of the CURRENT INPUT MODE, and it has to agree with the
 * host's dispatch or it lies to the human: an overlay owns the keyboard, so it
 * owns the footer; a focused field owns it one level further down. The per-mode
 * legends live together here, next to the fitting logic, so that agreement is
 * one file's job.
 */

export interface Hint {
  key: string;
  label: string;
  /**
   * A hint that yields: shown only while it costs no extra footer line. The
   * hint bar is charged against the viewport, so a platform-level key must not
   * take a row of content away from the applet that earned it.
   */
  optional?: boolean;
}

/**
 * The platform's own keybind: copy an agent-ready prompt for whatever surface
 * is on screen. It lives here (not in any applet's keymap) because it works on
 * every applet — the host handles it, the same way it handles `/` for search.
 * An applet that binds the key itself keeps it, so this is a default rather
 * than a reservation.
 */
export const COPY_PROMPT_KEY = "y";
// Kept short on purpose: the hint bar is charged against the viewport, and a
// two-line footer costs every applet a row of content.
export const COPY_PROMPT_LABEL = "prompt";

/** Arrow/space keys read better as glyphs in the hint bar than as names. */
const KEY_GLYPH: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", return: "enter" };
export const glyph = (key: string) => KEY_GLYPH[key] ?? key;

/** What enter does in a focused field — the applet names it, else "save". */
export const fieldSubmitLabel = (f: InputNode): string => (f.submit ? (f.submitLabel ?? "save") : "done");

/**
 * What the keyboard does inside the focused field. A textarea spends enter on a
 * newline, so its exit key is ctrl+d and the footer has to say so — the hint
 * bar is the only place that tells you how to get out.
 */
function fieldSubmitHints(f: InputNode): Hint[] {
  if (!f.multiline) return [{ key: "enter", label: fieldSubmitLabel(f) }];
  return [
    { key: "ctrl+d", label: fieldSubmitLabel(f) },
    { key: "enter", label: "newline" },
  ];
}

const QUIT: Hint = { key: "ctrl+c", label: "quit" };

/**
 * Hints for the applet's own keymap, in declaration order. Bindings whose
 * `when` guard is false are dropped (the key does nothing right now), and
 * adjacent bindings sharing a label collapse into one hint — so a pair like
 * ← seek / → seek reads as "←→ seek" instead of eating the footer twice.
 */
export function keymapHints(def: AppletDef, state: AppletState): Hint[] {
  const hints: Hint[] = [];
  for (const key of Object.keys(def.keymap ?? {})) {
    const b = bindingFor(def, key, state);
    if (!b) continue;
    const last = hints[hints.length - 1];
    if (last && last.label === b.label) last.key += glyph(key);
    else hints.push({ key: glyph(key), label: b.label });
  }
  return hints;
}

/**
 * Overlay mode: a dialog owns the keyboard, so showing the body's keybinds
 * under it would be a lie about what they do. A field inside the dialog owns it
 * one level further down: enter and esc are then the FIELD's, and the dialog
 * keeps only its extra keys.
 */
export function overlayHints(overlay: Overlay, focused: InputNode | null): Hint[] {
  const hints: Hint[] = [];
  if (focused) hints.push(...fieldSubmitHints(focused));
  else if (overlay.confirm) hints.push({ key: "enter", label: overlay.confirmLabel ?? overlay.confirm });
  for (const [key, b] of Object.entries(overlay.keymap ?? {})) {
    hints.push({ key: glyph(key), label: normalizeBinding(b).label });
  }
  if (focused) hints.push({ key: focused.multiline ? "↑↓←→" : "←→", label: "move" });
  hints.push({
    key: "esc",
    label: focused?.cancel
      ? (focused.cancelLabel ?? overlay.dismissLabel ?? "cancel")
      : (overlay.dismissLabel ?? (overlay.dismiss ? "cancel" : "back")),
  });
  hints.push(QUIT);
  return hints;
}

/**
 * Field mode: a focused field owns the keyboard, so it owns the hint bar too —
 * showing nav keys there would be a lie (← moves the caret, not the view).
 */
export function fieldHints(field: InputNode): Hint[] {
  // A textarea spends enter on a newline, so its exit key is ctrl+d and the
  // footer has to say so — the hint bar is the only place that tells you how to
  // get out. A textarea also navigates in two axes.
  return [
    ...fieldSubmitHints(field),
    { key: "esc", label: field.cancel ? (field.cancelLabel ?? "cancel") : "back" },
    { key: field.multiline ? "↑↓←→" : "←→", label: "move" },
    QUIT,
  ];
}

/**
 * Normal mode: navigation intents + the applet's keymap + meta back/quit.
 * A keymap entry that claims ←/→ in this state wins over the nav intent (the
 * host dispatches the same way), so the hints name the key that still
 * navigates: enter to select, esc to go back.
 */
export function appletHints(def: AppletDef, state: AppletState): Hint[] {
  const nav = def.nav;
  const claims = (key: string) => !!bindingFor(def, key, state);
  const hints: Hint[] = [];
  if (nav?.up || nav?.down) hints.push({ key: "↑↓", label: "move" });
  if (nav?.select) hints.push({ key: claims("right") ? "enter" : "→", label: nav.selectLabel ?? "open" });
  if (def.search) hints.push({ key: "/", label: "search" });
  hints.push(...keymapHints(def, state));
  // The platform keybind, unless this applet claimed the key for itself.
  if (!claims(COPY_PROMPT_KEY)) hints.push({ key: COPY_PROMPT_KEY, label: COPY_PROMPT_LABEL, optional: true });
  const canBack = nav?.canBack?.(state) ?? false;
  hints.push({ key: claims("left") ? "esc" : "←/esc", label: canBack ? (nav?.backLabel ?? "back") : "menu" });
  hints.push(QUIT);
  return hints;
}

/** The launcher's own three keys. */
export function launcherHints(): Hint[] {
  return [
    { key: "↑↓", label: "move" },
    { key: "enter", label: "open" },
    { key: "/", label: "filter" },
    QUIT,
  ];
}

// --- Fitting. The bar wraps rather than clipping mid-label, but never past two
// lines — an applet with many keys gives up its least important hints (the tail
// of its keymap) instead of eating the viewport.

export const FOOTER_MAX_LINES = 2;
const HINT_GAP = 4;
const hintWidth = (h: Hint) => h.key.length + 1 + h.label.length;

/** Lines this legend needs at `cap` columns (greedy, like the text wrap). */
export function linesFor(hints: Hint[], cap: number): number {
  let lines = 1;
  let used = 0;
  for (const h of hints) {
    const w = hintWidth(h);
    if (used && used + HINT_GAP + w > cap) {
      lines++;
      used = w;
    } else {
      used += (used ? HINT_GAP : 0) + w;
    }
  }
  return lines;
}

/**
 * Trim hints until the legend fits, keeping the last two (back, quit) —
 * whatever else goes, you can always leave the applet.
 */
export function fitHints(hints: Hint[], cap: number): Hint[] {
  const pinned = hints.slice(-2);
  const rest = hints.slice(0, -2);
  let shown = hints;
  let n = rest.length;
  while (n > 0 && linesFor(shown, cap) > FOOTER_MAX_LINES) {
    n--;
    shown = [...rest.slice(0, n), { key: "…", label: "" }, ...pinned];
  }
  return shown;
}

/** The legend as styled cells: a bold key, a dim label, four spaces between. */
export function hintChunks(hints: Hint[], c: { dim: Color; key: Color }): TextChunk[] {
  const chunks: TextChunk[] = [];
  hints.forEach((h, i) => {
    if (i) chunks.push(fg(c.dim)("    "));
    chunks.push(fg(c.key)(bold(h.key)));
    chunks.push(fg(c.dim)(h.label ? ` ${h.label}` : ""));
  });
  return chunks;
}
