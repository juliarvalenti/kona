import {
  TextRenderable,
  BoxRenderable,
  ASCIIFontRenderable,
  ScrollBoxRenderable,
  StyledText,
  fg,
  bg,
  bold,
  type CliRenderer,
  type MouseEvent,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import { bindingFor, type AppletDef, type AppletState, type KeyBinding, type Overlay, type ViewNode, type LayoutOpts, type InputNode } from "../sdk/index.ts";
import { type Edit, edit as mkEdit, windowOf } from "./editor.ts";
import { theme, appletAccent, type Theme } from "../core/config.ts";

/**
 * The stage: everything that turns applet view-nodes into OpenTUI renderables —
 * the bordered frame, the keybind hint bar, and the node->widget mapping. It is
 * renderer-agnostic, so the live host drives it with a real CliRenderer and the
 * snapshot tool/tests drive it with a headless test renderer.
 */

/**
 * The stage owns NO colors of its own — every hex comes from the central theme
 * (`~/.config/kona/config.toml`; defaults and roles in core/config.ts).
 */
const palette = (): Theme => theme();

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
 * every applet AND the launcher — the host handles it, the same way it handles
 * `/` for search. An applet that binds the key itself keeps it, so this is a
 * default rather than a reservation.
 */
export const COPY_PROMPT_KEY = "y";
// Kept short on purpose: the hint bar is charged against the viewport, and a
// two-line footer costs every applet a row of content.
const COPY_PROMPT_LABEL = "prompt";

/**
 * A mouse gesture, already resolved against what is on screen — the host never
 * sees raw coordinates. `index` is the selectable row under the pointer (the
 * `index` its view node carried), null when the click missed every row.
 */
export interface StageMouse {
  kind: "click" | "wheel";
  index: number | null;
  /** Wheel movement in lines: negative up, positive down. Zero for a click. */
  lines: number;
}

const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
} as const;

function layoutProps(o: LayoutOpts) {
  return {
    ...(o.align ? { alignItems: ALIGN[o.align] } : {}),
    ...(o.justify ? { justifyContent: JUSTIFY[o.justify] } : {}),
    ...(o.gap !== undefined ? { gap: o.gap } : {}),
    ...(o.padding !== undefined ? { padding: o.padding } : {}),
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.grow ? { flexGrow: 1 } : {}),
  };
}

function bindingLabel(b: KeyBinding): string {
  return typeof b === "string" ? b : (b.label ?? b.verb);
}

/** What enter does in a focused field — the applet names it, else "save". */
const fieldSubmitLabel = (f: InputNode): string => (f.submit ? (f.submitLabel ?? "save") : "done");

/** Focusable leaves: a selected list row, or the text field with the keyboard. */
const isFocused = (n: ViewNode): boolean =>
  typeof n === "object" && (n.kind === "text" || n.kind === "input") && !!n.focus;

/** Arrow/space keys read better as glyphs in the hint bar than as names. */
const KEY_GLYPH: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", return: "enter" };
const glyph = (key: string) => KEY_GLYPH[key] ?? key;

/**
 * Hints for the applet's own keymap, in declaration order. Bindings whose
 * `when` guard is false are dropped (the key does nothing right now), and
 * adjacent bindings sharing a label collapse into one hint — so a pair like
 * ← seek / → seek reads as "←→ seek" instead of eating the footer twice.
 */
function keymapHints(def: AppletDef, state: AppletState): Hint[] {
  const hints: Hint[] = [];
  for (const key of Object.keys(def.keymap ?? {})) {
    const b = bindingFor(def, key, state);
    if (!b) continue;
    const label = bindingLabel(b);
    const last = hints[hints.length - 1];
    if (last && last.label === label) last.key += glyph(key);
    else hints.push({ key: glyph(key), label });
  }
  return hints;
}

/**
 * Line offset of the focused node (the selected list row), so the host can
 * scroll it into view. Approximate heights in lines — good enough because focus
 * only lives on single-line rows in a column.
 */
function focusLineOf(nodes: ViewNode[]): number | null {
  let line = 0;
  let found: number | null = null;
  const visit = (n: ViewNode) => {
    if (found !== null) return;
    if (typeof n === "string") {
      line += 1;
      return;
    }
    switch (n.kind) {
      case "text":
      case "input":
        if (isFocused(n)) found = line;
        line += 1;
        break;
      case "spacer":
      case "bar":
        line += 1;
        break;
      case "big":
        line += 6;
        break;
      case "row":
        for (const c of n.children) if (isFocused(c)) found = line;
        line += 1;
        break;
      case "col":
        for (const c of n.children) visit(c);
        break;
      case "box": {
        const chrome = n.opts.border === false ? 0 : 1; // top border line
        line += chrome;
        for (const c of n.children) visit(c);
        line += chrome; // bottom border line
        break;
      }
    }
  };
  nodes.forEach(visit);
  return found;
}

/** The focused `input` node anywhere in the tree — the field with the keyboard. */
function findFocusedInput(nodes: ViewNode[]): InputNode | null {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (n.kind === "input" && n.focus) return n;
    // Descend containers AND boxes: a form inside a card or a modal is still a
    // form, and the field in it still has the keyboard.
    if (n.kind === "row" || n.kind === "col" || n.kind === "box") {
      const hit = findFocusedInput(n.children);
      if (hit) return hit;
    }
  }
  return null;
}

/** The keystrokes a focused field has taken but not yet submitted. */
export interface Draft {
  id: string;
  edit: Edit;
}

export interface Stage {
  renderApplet(def: AppletDef, state: AppletState): void;
  renderLauncher(applets: AppletDef[], cursor: number): void;
  footerNote(text: string, color?: string): void;
  searchBar(buf: Edit, placeholder?: string): void;
  /** The `input` node currently holding the keyboard, if any. */
  focusedInput(): InputNode | null;
  /** In-flight keystrokes for a focused field; the host owns them. */
  setDraft(draft: Draft | null): void;
  scrollBy(lines: number): void;
  scrollTop(): number;
  /** Receive mouse gestures (one handler; the host owns what they mean). */
  onMouse(handler: (e: StageMouse) => void): void;
  viewportHeight(): number;
  hasFocusTarget(): boolean;
  resetScroll(): void;
}

export function createStage(renderer: CliRenderer): Stage {
  const {
    dim: DIM,
    fg: FG,
    accent: ACCENT,
    key: KEY,
    field: FIELD,
    fieldFocus: FIELD_FOCUS,
    caret: CARET,
    caretFg: CARET_FG,
    panel: PANEL,
  } = palette();

  // Inner content size = terminal size minus fixed chrome. Width: stage pad 2 +
  // border 2 + frame pad 2 + scrollbar column 1 = 7. Height: the same 6, plus
  // however many lines the hint bar currently occupies (it wraps to two when an
  // applet has a lot of keys). Derived from the renderer, which knows the
  // terminal size immediately.
  const term = renderer as unknown as { width: number; height: number };
  let footerLines = 1;
  const innerWidth = () => Math.max(20, term.width - 7);
  const innerHeight = () => Math.max(6, term.height - 6 - footerLines);

  // The frame fills the terminal (minus a 1-cell margin), with the hint bar
  // pinned below. A bounded width is also what lets long lines word-wrap.
  renderer.root.flexDirection = "column";
  const stage = new BoxRenderable(renderer, {
    id: "stage",
    flexGrow: 1,
    padding: 1,
    flexDirection: "column",
    alignItems: "stretch",
  });
  const frame = new BoxRenderable(renderer, {
    id: "frame",
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    padding: 1,
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "stretch", // children fill width; applets align themselves
  });
  // Content lives in a scroll viewport: overflow scrolls/clips instead of
  // flex-shrinking every child on top of each other (which corrupted the view).
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "scroll",
    flexGrow: 1,
    scrollY: true,
    contentOptions: { flexDirection: "column", alignItems: "stretch" },
  });
  frame.add(scroll);
  // The overlay layer: absolutely positioned over the whole content area and
  // stacked above it, so a modal floats instead of taking part in the flow.
  // Transparent and hidden until an applet returns an overlay.
  const overlayLayer = new BoxRenderable(renderer, {
    id: "overlay",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  });
  frame.add(overlayLayer);
  stage.add(frame);
  const footer = new TextRenderable(renderer, { id: "footer", content: "", paddingLeft: 1, wrapMode: "word" });
  renderer.root.add(stage);
  renderer.root.add(footer);

  // The hint bar wraps rather than clipping mid-label, but never past two lines
  // — an applet with many keys gives up its least important hints (the tail of
  // its keymap) instead of eating the viewport.
  const FOOTER_MAX_LINES = 2;
  const HINT_GAP = 4;
  const hintWidth = (h: Hint) => h.key.length + 1 + h.label.length;

  /** Lines this legend needs at `cap` columns (greedy, like the text wrap). */
  function linesFor(hints: Hint[], cap: number): number {
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

  /** Trim hints until the legend fits, keeping the last two (back, quit) —
   * whatever else goes, you can always leave the applet. */
  function fitHints(hints: Hint[], cap: number): Hint[] {
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

  // --- Mouse. Rows register themselves as click targets while the frame is
  // built, so a click resolves by hit-testing the actual renderables — no
  // screen-line arithmetic, and wrapping/scrolling are handled for free.
  let clickTargets: Array<{ index: number; node: Renderable }> = [];
  let onMouseGesture: ((e: StageMouse) => void) | null = null;
  const WHEEL_LINES = 3;

  /** The selectable row under a screen y, or null (chrome, gaps, plain text). */
  function indexAt(y: number): number | null {
    const vp = scroll.viewport;
    // Rows scrolled out of the viewport keep their (off-screen) coordinates.
    if (y < vp.screenY || y >= vp.screenY + vp.height) return null;
    for (const t of clickTargets) {
      if (t.node.isDestroyed) continue;
      if (y >= t.node.screenY && y < t.node.screenY + t.node.height) return t.index;
    }
    return null;
  }

  function wheel(e: MouseEvent): boolean {
    const dir = e.scroll?.direction;
    if (dir !== "up" && dir !== "down") return false;
    const ticks = Math.max(1, e.scroll?.delta ?? 1);
    onMouseGesture?.({ kind: "wheel", index: null, lines: (dir === "up" ? -1 : 1) * WHEEL_LINES * ticks });
    return true;
  }

  // Take the wheel before it reaches the ScrollBox, so it moves the viewport in
  // steady whole-line steps rather than ScrollBox's own accelerated scrolling —
  // and so the host stays the one place that decides what an input means.
  scroll.content.onMouse = (e: MouseEvent) => {
    if (e.type === "scroll" && wheel(e)) e.stopPropagation();
  };

  // Everything else bubbles to the root: clicks anywhere, plus a wheel over the
  // chrome (border, footer) that never passed through the content box.
  renderer.root.onMouse = (e: MouseEvent) => {
    if (e.type === "down" && e.button === 0) onMouseGesture?.({ kind: "click", index: indexAt(e.y), lines: 0 });
    else if (e.type === "scroll") wheel(e);
  };

  function setFooter(hints: Hint[]) {
    const cap = Math.max(20, term.width - 1); // paddingLeft
    // Optional hints are the first thing to go — before the trimming below —
    // and they go silently: they buy a whole line of viewport back.
    const required = hints.filter((h) => !h.optional);
    const affordable = linesFor(hints, cap) > linesFor(required, cap) ? required : hints;
    const shown = fitHints(affordable, cap);
    footerLines = Math.min(FOOTER_MAX_LINES, linesFor(shown, cap));
    const chunks: TextChunk[] = [];
    shown.forEach((h, i) => {
      if (i) chunks.push(fg(DIM)("    "));
      chunks.push(fg(KEY)(bold(h.key)));
      chunks.push(fg(DIM)(h.label ? ` ${h.label}` : ""));
    });
    footer.content = new StyledText(chunks);
    renderer.requestRender();
  }

  // Rebuild the frame's children each render; destroy old nodes so native
  // buffers (ASCII fonts) don't leak.
  let seq = 0;
  let hasFocus = false;
  // The field with the keyboard, and the keystrokes it has taken but not yet
  // submitted. The draft lives here (not in daemon state) so typing is instant
  // and a background state push mid-word can't clobber what you typed.
  let focused: InputNode | null = null;
  let draft: Draft | null = null;
  function setFrame(title: string, titleColor: string, nodes: ViewNode[], overlay?: Overlay | null) {
    frame.title = ` ${title} `;
    frame.titleAlignment = "center";
    frame.borderColor = titleColor;
    // Preserve scroll position across rebuilds — appends (load-more) and idle
    // refreshes shouldn't jump the view back to the top. Transitions call
    // resetScroll() explicitly.
    const prevScroll = scroll.scrollTop;
    clickTargets = [];
    for (const child of [...scroll.content.getChildren()]) {
      scroll.content.remove(child);
      (child as { destroy?: () => void }).destroy?.();
    }
    // An overlay owns the keyboard, so only ITS fields can be focused: a field
    // in the body behind a dialog must not keep typing into it.
    focused = overlay ? findFocusedInput([overlay.node]) : findFocusedInput(nodes);
    const gen = seq++;
    nodes.forEach((node, i) => scroll.content.add(nodeToRenderable(node, `n${gen}-${i}`)));

    // Scroll-to-follow-selection: only move the viewport when the focused row
    // would be off-screen — a list that fits never scrolls.
    const focusLine = focusLineOf(nodes);
    hasFocus = focusLine !== null;
    let top = prevScroll;
    if (focusLine !== null) {
      const vh = innerHeight();
      if (focusLine < top) top = focusLine;
      else if (focusLine > top + vh - 1) top = focusLine - vh + 1;
    }
    scroll.scrollTop = Math.max(0, top);
    setOverlay(overlay ?? null, gen);
    renderer.requestRender();
  }

  /**
   * A text field as styled cells: a padded trough so the highlight spans the
   * whole field, with the caret drawn as an inverted cell inside it (OpenTUI
   * paints through its own buffer, so there is no real terminal cursor to move).
   */
  function inputChunks(node: InputNode): TextChunk[] {
    const width = Math.max(1, node.width ?? 32);
    const live = node.focus && draft?.id === node.id ? draft.edit : mkEdit(node.value);
    const buf: Edit = node.mask ? mkEdit("•".repeat(live.value.length), live.cursor) : live;
    const trough = node.focus ? FIELD_FOCUS : FIELD;
    const ink = node.color ?? FG;
    const paint = (t: string) => fg(ink)(bg(trough)(t));
    const hint = (t: string) => fg(DIM)(bg(trough)(t));

    if (!node.focus) {
      const empty = buf.value.length === 0;
      const shown = empty ? (node.placeholder ?? "") : buf.value;
      const body = (shown.length > width ? shown.slice(0, width - 1) + "…" : shown).padEnd(width);
      return [empty ? hint(body) : paint(body)];
    }

    const win = windowOf(buf, width);
    const line = win.text.padEnd(width);
    const caret = fg(CARET_FG)(bg(CARET)(line.slice(win.cursor, win.cursor + 1) || " "));
    // An empty focused field still advertises what it wants, to the caret's right.
    const tail =
      buf.value.length === 0 && node.placeholder
        ? hint(node.placeholder.slice(0, width - 1).padEnd(width - 1))
        : paint(line.slice(win.cursor + 1));
    return [paint(line.slice(0, win.cursor)), caret, tail].filter((c) => c.text.length > 0);
  }

  function setOverlay(overlay: Overlay | null, gen: number) {
    for (const child of [...overlayLayer.getChildren()]) {
      overlayLayer.remove(child);
      (child as { destroy?: () => void }).destroy?.();
    }
    overlayLayer.visible = overlay !== null;
    // Cells have no alpha, so a scrim is an opaque fill, not a tint: it covers
    // the body rather than dimming it. Without one the layer stays transparent
    // and only the overlay node itself hides what it sits on.
    overlayLayer.backgroundColor = overlay?.scrim ? PANEL : "transparent";
    if (overlay) overlayLayer.add(nodeToRenderable(overlay.node, `ov${gen}`));
  }

  function nodeToRenderable(node: ViewNode, id: string): Renderable {
    // flexShrink:0 everywhere — leaves must keep their height so they never
    // collapse on top of each other when content exceeds the viewport.
    if (typeof node === "string") return new TextRenderable(renderer, { id, content: node, fg: FG, wrapMode: "word", flexShrink: 0 });
    switch (node.kind) {
      case "big":
        return new ASCIIFontRenderable(renderer, { id, text: node.text, font: node.font ?? "block", color: node.color ?? FG, flexShrink: 0 });
      case "text": {
        const label = new TextRenderable(renderer, {
          id: node.bg ? `${id}-t` : id,
          content: node.text,
          fg: node.dim ? DIM : (node.color ?? FG),
          ...(node.bg ? { bg: node.bg } : {}),
          wrapMode: "word",
          flexShrink: 0,
        });
        const claim = (n: Renderable) => {
          if (node.index !== undefined) clickTargets.push({ index: node.index, node: n });
          return n;
        };
        if (!node.bg) return claim(label);
        // Wrap in a bg box so the highlight spans the FULL row width (a text
        // node's bg only paints behind its glyphs; a box fills its stretched box).
        const bar = new BoxRenderable(renderer, {
          id,
          backgroundColor: node.bg,
          flexDirection: "row",
          flexShrink: 0,
        });
        bar.add(label);
        return claim(bar);
      }
      case "spacer":
        return new TextRenderable(renderer, { id, content: " ", flexShrink: 0 });
      case "row":
      case "col": {
        const box = new BoxRenderable(renderer, {
          id,
          flexDirection: node.kind === "row" ? "row" : "column",
          ...layoutProps(node.opts),
        });
        node.children.forEach((child, i) => box.add(nodeToRenderable(child, `${id}.${i}`)));
        return box;
      }
      case "input":
        return new TextRenderable(renderer, {
          id,
          content: new StyledText(inputChunks(node)),
          wrapMode: "none",
          flexShrink: 0,
        });
      case "box": {
        const o = node.opts;
        // A titled box borders itself unless told otherwise — a floating title
        // with no frame reads as stray text.
        const bordered = o.border ?? o.title !== undefined;
        const panel = new BoxRenderable(renderer, {
          id,
          flexDirection: "column",
          flexShrink: 0,
          ...(bordered
            ? { border: true, borderStyle: o.borderStyle ?? "rounded", borderColor: o.borderColor ?? DIM }
            : {}),
          ...(o.title !== undefined
            ? { title: ` ${o.title} `, titleAlignment: o.titleAlign ?? "left", titleColor: o.borderColor ?? ACCENT }
            : {}),
          ...(o.bg ? { backgroundColor: o.bg } : {}),
          ...layoutProps(o),
        });
        node.children.forEach((child, i) => panel.add(nodeToRenderable(child, `${id}.${i}`)));
        return panel;
      }
      case "bar": {
        const width = node.width ?? 24;
        // Sub-cell resolution: full blocks + one fractional block = 8x smoother,
        // so slow bars visibly move instead of looking frozen.
        const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
        const eighths = Math.round(node.value * width * 8);
        const full = Math.floor(eighths / 8);
        const partial = PARTIALS[eighths % 8]!;
        const content = ("█".repeat(full) + partial).padEnd(width, "░");
        return new TextRenderable(renderer, { id, content, fg: node.color ?? FG });
      }
    }
  }

  return {
    renderApplet(def, state) {
      const body = def.view(state, { width: innerWidth(), height: innerHeight() });
      const nodes: ViewNode[] = Array.isArray(body) ? (body as ViewNode[]) : [body as ViewNode];
      // An applet's own accent(state) is dynamic (the timer's run/pause tint)
      // and always wins; otherwise `[applets.<id>].accent` sets the frame color.
      const accent = def.accent?.(state) ?? appletAccent(def.id, ACCENT);
      const crumb = def.crumb?.(state);
      const overlay = def.overlay?.(state) ?? null;
      setFrame(crumb ? `${def.title} › ${crumb}` : def.title, accent, nodes, overlay);

      // An overlay owns the keyboard, so it owns the hint bar too — showing the
      // body's keybinds under a dialog would be a lie about what they do. A
      // field inside the dialog owns it one level further down: enter and esc
      // are then the FIELD's, and the dialog keeps only its extra keys.
      if (overlay) {
        const hints: Hint[] = [];
        if (focused) hints.push({ key: "enter", label: fieldSubmitLabel(focused) });
        else if (overlay.confirm) hints.push({ key: "enter", label: overlay.confirmLabel ?? overlay.confirm });
        for (const [key, b] of Object.entries(overlay.keymap ?? {})) hints.push({ key: glyph(key), label: bindingLabel(b) });
        if (focused) hints.push({ key: "←→", label: "move" });
        hints.push({
          key: "esc",
          label: focused?.cancel
            ? (focused.cancelLabel ?? overlay.dismissLabel ?? "cancel")
            : (overlay.dismissLabel ?? (overlay.dismiss ? "cancel" : "back")),
        });
        hints.push({ key: "ctrl+c", label: "quit" });
        setFooter(hints);
        return;
      }

      // A focused field owns the keyboard, so it owns the hint bar too —
      // showing nav keys there would be a lie (← moves the caret, not the view).
      if (focused) {
        setFooter([
          { key: "enter", label: fieldSubmitLabel(focused) },
          { key: "esc", label: focused.cancel ? (focused.cancelLabel ?? "cancel") : "back" },
          { key: "←→", label: "move" },
          { key: "ctrl+c", label: "quit" },
        ]);
        return;
      }

      // Hint bar = navigation intents + the applet's keymap + meta back/quit.
      // A keymap entry that claims ←/→ in this state wins over the nav intent
      // (the host dispatches the same way), so the hints name the key that
      // still navigates: enter to select, esc to go back.
      const nav = def.nav;
      const km = keymapHints(def, state);
      const claims = (key: string) => !!bindingFor(def, key, state);
      const hints: Hint[] = [];
      if (nav?.up || nav?.down) hints.push({ key: "↑↓", label: "move" });
      if (nav?.select) hints.push({ key: claims("right") ? "enter" : "→", label: nav.selectLabel ?? "open" });
      if (def.search) hints.push({ key: "/", label: "search" });
      hints.push(...km);
      // The platform keybind, unless this applet claimed the key for itself.
      if (!claims(COPY_PROMPT_KEY)) hints.push({ key: COPY_PROMPT_KEY, label: COPY_PROMPT_LABEL, optional: true });
      const canBack = nav?.canBack?.(state) ?? false;
      hints.push({ key: claims("left") ? "esc" : "←/esc", label: canBack ? (nav?.backLabel ?? "back") : "menu" });
      hints.push({ key: "ctrl+c", label: "quit" });
      setFooter(hints);
    },
    renderLauncher(applets, cursor) {
      const nodes: ViewNode[] = [{ kind: "text", text: "pick an app", dim: true }, { kind: "spacer" }];
      applets.forEach((a, i) => {
        const sel = i === cursor;
        nodes.push({ kind: "text", text: `${sel ? "▸" : " "} ${a.title}`, color: sel ? ACCENT : FG, index: i });
      });
      setFrame("kona", ACCENT, nodes);
      setFooter([
        { key: "↑/↓", label: "move" },
        { key: "enter", label: "open" },
        { key: COPY_PROMPT_KEY, label: COPY_PROMPT_LABEL },
        { key: "ctrl+c", label: "quit" },
      ]);
    },
    footerNote(text, color = palette().error) {
      footer.content = new StyledText([fg(color)(text)]);
      renderer.requestRender();
    },
    searchBar(buf, placeholder) {
      // The same caret-in-the-text treatment as an `input` node, so the footer
      // editor and a field in the view tree feel like one widget.
      const chunks: TextChunk[] = [fg(ACCENT)(bold("search "))];
      if (buf.value.length === 0) {
        chunks.push(fg(CARET)("█"), fg(DIM)(placeholder ?? ""));
      } else {
        const at = buf.value.slice(buf.cursor, buf.cursor + 1);
        chunks.push(
          fg(FG)(buf.value.slice(0, buf.cursor)),
          at ? fg(CARET_FG)(bg(CARET)(at)) : fg(CARET)("█"),
          fg(FG)(buf.value.slice(buf.cursor + 1)),
        );
      }
      chunks.push(fg(DIM)("    enter apply · esc cancel"));
      footer.content = new StyledText(chunks.filter((c) => c.text.length > 0));
      renderer.requestRender();
    },
    focusedInput() {
      return focused;
    },
    setDraft(next) {
      draft = next;
    },
    scrollBy(lines) {
      // Clamp to [0, maxScroll] so a list that fits never scrolls into empty
      // space (the "whole group scrolls on down 1" bug).
      const max = Math.max(0, scroll.scrollHeight - scroll.viewport.height);
      scroll.scrollTop = Math.max(0, Math.min(max, scroll.scrollTop + lines));
      renderer.requestRender();
    },
    scrollTop() {
      return scroll.scrollTop;
    },
    onMouse(handler) {
      onMouseGesture = handler;
    },
    viewportHeight() {
      return innerHeight();
    },
    hasFocusTarget() {
      return hasFocus;
    },
    resetScroll() {
      scroll.scrollTop = 0;
      renderer.requestRender();
    },
  };
}
