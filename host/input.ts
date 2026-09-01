import { bindingFor, normalizeBinding, type AppletDef, type AppletState, type InputNode, type Overlay } from "../sdk/index.ts";
import { applyKey, edit as mkEdit, type Edit, type KeyEvent } from "./editor.ts";
import type { Draft } from "./field.ts";

/**
 * The host's input state machine.
 *
 * Every keypress lands in exactly ONE mode, and the modes have a fixed
 * precedence:
 *
 *   launcher  no applet open — the app list has the keyboard
 *   overlay   a dialog is up: the body behind it must not move
 *   search    the `/` footer line editor is open
 *   field     an `input` node in the view tree holds the keyboard
 *   normal    the applet's keymap, then the canonical nav intents
 *
 * This used to be an if-ladder inside the keypress handler, where the
 * precedence was implicit in statement order and one misplaced early return
 * could silently hand the wrong mode a key. Here the mode is named
 * (`modeOf`), the resolution is pure (`resolveKey` — a key in, an ACTION out)
 * and the host does nothing but execute the action it gets back. Everything
 * except the effects is testable without a terminal or a daemon.
 */

// Canonical navigation intents, each matched by an arrow key AND a vim key.
// Exported because the launcher's own mini state machine (in ./index.ts) reads
// the same intents to keep hjkl navigating instead of starting a filter.
export const isUp = (n: string) => n === "up" || n === "k";
export const isDown = (n: string) => n === "down" || n === "j";
export const isSelect = (n: string) => n === "return" || n === "right" || n === "l";
export const isBack = (n: string) => n === "escape" || n === "left" || n === "backspace" || n === "h";

/**
 * The name a keypress goes into a keymap under. A ctrl-held key is its own
 * binding (`ctrl+s`), so an applet can bind one without shadowing the plain
 * letter — and the hint bar shows it as the fingers press it.
 */
export function keyName(k: { name: string; ctrl?: boolean }): string {
  return k.ctrl ? `ctrl+${k.name}` : k.name;
}

export type InputMode = "launcher" | "overlay" | "search" | "field" | "normal";

/** Everything the machine needs to know about what is on screen right now. */
export interface InputContext {
  /** The open applet; null means the launcher. */
  def: AppletDef | null;
  state: AppletState;
  /** The applet's overlay in this state, if any. */
  overlay: Overlay | null;
  /** The `input` node holding the keyboard — the stage decides which. */
  field: InputNode | null;
  /** The `/` search buffer, while the footer editor is open. */
  search: Edit | null;
  /** In-flight keystrokes for a focused field. */
  draft: Draft | null;
}

/** Which mode owns the keyboard. The precedence lives here and nowhere else. */
export function modeOf(ctx: InputContext): InputMode {
  if (!ctx.def) return "launcher";
  // A dialog owns the keyboard — unless one of ITS fields does, one level down.
  if (ctx.overlay && !ctx.field) return "overlay";
  // `/` search is a footer editor over the body; a dialog outranks it.
  if (!ctx.overlay && ctx.search && ctx.def.search) return "search";
  if (ctx.field) return "field";
  return "normal";
}

/**
 * What a keypress means. The host turns these into verb calls, renders and
 * navigation — the machine itself performs no effects.
 */
export type InputAction =
  | { kind: "quit" }
  /** Swallowed on purpose: the key does nothing in this mode. */
  | { kind: "none" }
  | { kind: "launcherMove"; delta: -1 | 1 }
  | { kind: "launcherOpen" }
  /** Fire one of the applet's verbs (a keymap binding, or a dialog's). */
  | { kind: "verb"; verb: string; args: Record<string, unknown> }
  | { kind: "searchOpen" }
  | { kind: "searchEdit"; edit: Edit }
  | { kind: "searchSubmit"; q: string }
  | { kind: "searchCancel" }
  | { kind: "fieldEdit"; field: InputNode; edit: Edit; changed: boolean }
  | { kind: "fieldSubmit"; field: InputNode; value: string }
  | { kind: "fieldCancel"; field: InputNode }
  | { kind: "back" }
  | { kind: "move"; delta: -1 | 1 }
  | { kind: "select" };

/** What a keypress does while an overlay owns the keyboard. */
export type OverlayAction =
  | { kind: "verb"; verb: string; args: Record<string, unknown> }
  | { kind: "trap" } // swallowed: the body must not move behind a dialog
  | { kind: "pass" }; // handled as usual by the applet

/**
 * Resolve a keypress against an open overlay. Confirm/dismiss/keymap fire
 * verbs; everything else is trapped — EXCEPT back on an overlay with no
 * dismiss verb, which passes through so an applet can never strand you in a
 * dialog it forgot to give an exit.
 */
export function overlayAction(overlay: Overlay, key: string): OverlayAction {
  if (isSelect(key) && overlay.confirm) return { kind: "verb", verb: overlay.confirm, args: {} };
  if (isBack(key)) return overlay.dismiss ? { kind: "verb", verb: overlay.dismiss, args: {} } : { kind: "pass" };
  const b = overlay.keymap?.[key];
  if (b) {
    const { verb, args } = normalizeBinding(b);
    return { kind: "verb", verb, args };
  }
  return { kind: "trap" };
}

/**
 * Normal mode: the applet's own keymap is matched FIRST, so a `when`-guarded
 * binding can claim a navigation key on one screen (spotify scrubs with ←/→
 * while now-playing) without stealing it everywhere else. Unclaimed keys fall
 * through to the canonical nav intents.
 */
function normalKey(def: AppletDef, state: AppletState, k: KeyEvent, key: string): InputAction {
  // `/` opens search on a searchable applet.
  if (def.search && k.sequence === "/") return { kind: "searchOpen" };

  const claimed = bindingFor(def, key, state);
  if (claimed) return { kind: "verb", verb: claimed.verb, args: claimed.args };

  if (isBack(key)) return { kind: "back" };
  if (isUp(key)) return { kind: "move", delta: -1 };
  if (isDown(key)) return { kind: "move", delta: 1 };
  if (isSelect(key) && def.nav?.select) return { kind: "select" };
  return { kind: "none" };
}

/** Search mode: the footer line editor has the keyboard. */
function searchKey(buf: Edit, k: KeyEvent): InputAction {
  const { edit: next, action } = applyKey(buf, k);
  if (action === "submit") return { kind: "searchSubmit", q: buf.value };
  if (action === "cancel") return { kind: "searchCancel" };
  if (action === "edit") return { kind: "searchEdit", edit: next };
  return { kind: "none" };
}

/**
 * Field mode: an `input` node in the view tree has focus, so every key is text
 * (even `/` and the arrows) until enter or esc ends the edit. A key the editor
 * has no use for (tab, say) still belongs to a dialog AROUND the field — that
 * is how a form moves between fields.
 */
function fieldKey(field: InputNode, draft: Draft | null, overlay: Overlay | null, k: KeyEvent, key: string): InputAction {
  const buf = draft?.id === field.id ? draft.edit : mkEdit(field.value);
  // A textarea spends enter on a newline, so the editor is told which shape the
  // field is: same brain, different exit key (ctrl+d) — #57's multiline editor.
  const { edit: next, action } = applyKey(buf, k, { multiline: field.multiline });
  if (action === "submit") return { kind: "fieldSubmit", field, value: buf.value };
  if (action === "cancel") return { kind: "fieldCancel", field };
  if (action === "edit") return { kind: "fieldEdit", field, edit: next, changed: next.value !== buf.value };
  if (overlay) {
    const dialogKey = overlayAction(overlay, key);
    if (dialogKey.kind === "verb") return { kind: "verb", verb: dialogKey.verb, args: dialogKey.args };
  }
  return { kind: "none" };
}

/** One keypress, one action. Pure: the caller performs the effects. */
export function resolveKey(ctx: InputContext, k: KeyEvent): InputAction {
  // ctrl+c outranks every mode — you can always leave.
  if (k.ctrl && k.name === "c") return { kind: "quit" };

  const key = keyName(k);
  const def = ctx.def;
  switch (modeOf(ctx)) {
    case "launcher":
      if (isUp(key)) return { kind: "launcherMove", delta: -1 };
      if (isDown(key)) return { kind: "launcherMove", delta: 1 };
      if (isSelect(key)) return { kind: "launcherOpen" };
      return { kind: "none" };

    case "overlay": {
      const action = overlayAction(ctx.overlay!, key);
      if (action.kind === "verb") return { kind: "verb", verb: action.verb, args: action.args };
      if (action.kind === "trap") return { kind: "none" };
      // "pass": a dialog with no exit lets back through to the applet, so it
      // can never strand you. Everything else about normal mode applies.
      return normalKey(def!, ctx.state, k, key);
    }

    case "search":
      return searchKey(ctx.search!, k);

    case "field":
      return fieldKey(ctx.field!, ctx.draft, ctx.overlay, k, key);

    case "normal":
      return normalKey(def!, ctx.state, k, key);
  }
}
