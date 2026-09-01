import { fg, StyledText, type CliRenderer } from "@opentui/core";
import { type AppletDef, type AppletState, type Overlay, type ViewNode, type InputNode } from "../sdk/index.ts";
import type { Edit } from "./editor.ts";
import { theme, appletAccent, appletString, type Theme } from "../core/config.ts";
import { createChrome, clearChildren } from "./chrome.ts";
import { inputChunks, inputLines, searchChunks, type Draft } from "./field.ts";
import { appletHints, fitHints, hintChunks, launcherHints, linesFor, overlayHints, fieldHints, FOOTER_MAX_LINES, type Hint } from "./hints.ts";
import { attachMouse, type ClickTarget, type StageMouse } from "./mouse.ts";
import { findFocusedInput, focusLineOf } from "./nodes.ts";
import { setOverlayLayer } from "./overlay.ts";
import { createNodeRenderer } from "./renderables.ts";
import { clampScroll, scrollToShow } from "./scroll.ts";

/**
 * The stage: the seam between an applet's view-nodes and the terminal.
 *
 * It owns no rendering details of its own — those are split by concern into
 * ./chrome.ts (the frame), ./renderables.ts (node -> widget), ./field.ts (text
 * fields), ./hints.ts (the hint bar), ./overlay.ts (the floating layer),
 * ./nodes.ts + ./scroll.ts (focus and scrolling) and ./mouse.ts (gestures).
 * What lives HERE is the wiring: one frame's worth of state (the focused
 * field, the draft, the click targets) and the `Stage` interface the host
 * drives. It is renderer-agnostic, so the live host drives it with a real
 * CliRenderer and the snapshot tool/tests drive it with a headless one.
 *
 * The stage owns NO colors of its own — every hex comes from the central theme
 * (`~/.config/kona/config.toml`; defaults and roles in core/config.ts).
 */

const palette = (): Theme => theme();

export type { Hint } from "./hints.ts";
export type { StageMouse } from "./mouse.ts";
export type { Draft } from "./field.ts";
// The platform's own copy-prompt keybind lives with the hint legend that
// advertises it; the host imports it from here as the stage's public surface.
export { COPY_PROMPT_KEY } from "./hints.ts";

/**
 * What the launcher is showing beyond the list itself. `applets` is already
 * FILTERED (the host owns the query and the cursor indexes what it passes), so
 * the stage only needs to know what the filter was to say so on screen.
 */
export interface LauncherOpts {
  /** The live filter, if one is open. */
  query?: string;
  /** How many applets exist in total, when `applets` is a filtered subset. */
  total?: number;
}

export interface Stage {
  renderApplet(def: AppletDef, state: AppletState): void;
  renderLauncher(applets: AppletDef[], cursor: number, opts?: LauncherOpts): void;
  footerNote(text: string, color?: string): void;
  searchBar(buf: Edit, placeholder?: string, opts?: { label?: string; hint?: string }): void;
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
  const colors = palette();
  const { fg: FG, dim: DIM, accent: ACCENT, key: KEY, panel: PANEL, bg: ON_ACCENT } = colors;

  // Inner content size = terminal size minus fixed chrome. Width: stage pad 2 +
  // border 2 + frame pad 2 + scrollbar column 1 = 7. Height: the same 6, plus
  // however many lines the hint bar currently occupies (it wraps to two when an
  // applet has a lot of keys). Derived from the renderer, which knows the
  // terminal size immediately.
  const term = renderer as unknown as { width: number; height: number };
  let footerLines = 1;
  const innerWidth = () => Math.max(20, term.width - 7);
  const innerHeight = () => Math.max(6, term.height - 6 - footerLines);

  const { frame, scroll, overlayLayer, footer } = createChrome(renderer, ACCENT);

  // --- One frame's worth of state. Rebuilt on every render.
  let seq = 0;
  let hasFocus = false;
  let clickTargets: ClickTarget[] = [];
  // The field with the keyboard, and the keystrokes it has taken but not yet
  // submitted. The draft lives here (not in daemon state) so typing is instant
  // and a background state push mid-word can't clobber what you typed.
  let focused: InputNode | null = null;
  let draft: Draft | null = null;

  const nodeToRenderable = createNodeRenderer(renderer, {
    colors: { fg: FG, dim: DIM, accent: ACCENT },
    inputChunks: (node) => inputChunks(node, draft, colors),
    inputLines: (node) => inputLines(node, draft, colors),
    claim: (index, node) => clickTargets.push({ index, node }),
  });

  let onMouseGesture: ((e: StageMouse) => void) | null = null;
  attachMouse(renderer, scroll, () => clickTargets, (e) => onMouseGesture?.(e));

  function setFooter(hints: Hint[]) {
    const cap = Math.max(20, term.width - 1); // paddingLeft
    // Optional hints are the first thing to go — before the trimming below —
    // and they go silently: they buy a whole line of viewport back.
    const required = hints.filter((h) => !h.optional);
    const affordable = linesFor(hints, cap) > linesFor(required, cap) ? required : hints;
    const shown = fitHints(affordable, cap);
    footerLines = Math.min(FOOTER_MAX_LINES, linesFor(shown, cap));
    footer.content = new StyledText(hintChunks(shown, { dim: DIM, key: KEY }));
    renderer.requestRender();
  }

  // Rebuild the frame's children each render; destroy old nodes so native
  // buffers (ASCII fonts) don't leak. `peek` is how many lines BELOW the
  // focused row must stay on screen with it — the launcher's rows carry a
  // summary underneath, and following the title alone would leave it hanging
  // off the bottom edge.
  function setFrame(title: string, titleColor: string, nodes: ViewNode[], overlay?: Overlay | null, peek = 0) {
    frame.title = ` ${title} `;
    frame.titleAlignment = "center";
    frame.borderColor = titleColor;
    // Preserve scroll position across rebuilds — appends (load-more) and idle
    // refreshes shouldn't jump the view back to the top. Transitions call
    // resetScroll() explicitly.
    const prevScroll = scroll.scrollTop;
    clickTargets = [];
    clearChildren(scroll.content);
    // An overlay owns the keyboard, so only ITS fields can be focused: a field
    // in the body behind a dialog must not keep typing into it.
    focused = overlay ? findFocusedInput([overlay.node]) : findFocusedInput(nodes);
    const gen = seq++;
    nodes.forEach((node, i) => scroll.content.add(nodeToRenderable(node, `n${gen}-${i}`)));

    // Measure the children we just added BEFORE touching scrollTop. Layout is
    // lazy: until it runs, the ScrollBox still reports the PREVIOUS frame's
    // content height, and the scrollTop setter clamps against that — so a
    // freshly built list ignored its own scroll-to-follow and only caught up on
    // the next render (with an empty list, on nothing at all). Laying out the
    // root and reading the content's new size back makes the follow immediate.
    renderer.root.calculateLayout();
    scroll.content.updateFromLayout();

    // Scroll-to-follow-selection: only move the viewport when the focused row
    // would be off-screen — a list that fits never scrolls. `peek` keeps the
    // launcher's summary line on screen with the title it belongs to.
    const focusLine = focusLineOf(nodes);
    hasFocus = focusLine !== null;
    let top = prevScroll;
    if (focusLine !== null) {
      const vh = innerHeight();
      if (focusLine < top) top = focusLine;
      else if (focusLine + peek > top + vh - 1) top = focusLine + peek - vh + 1;
    }
    scroll.scrollTop = Math.max(0, top);
    setOverlayLayer(overlayLayer, overlay ?? null, (node) => nodeToRenderable(node, `ov${gen}`), PANEL);
    renderer.requestRender();
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

      // The hint bar renders the current INPUT MODE, in the same precedence the
      // host dispatches keys with: an overlay owns the keyboard, and a field
      // inside it owns the keyboard one level further down.
      if (overlay) setFooter(overlayHints(overlay, focused));
      else if (focused) setFooter(fieldHints(focused));
      else setFooter(appletHints(def, state));
    },
    renderLauncher(applets, cursor, opts = {}) {
      const W = innerWidth();
      const total = opts.total ?? applets.length;
      const q = opts.query ?? "";
      const clip = (s: string) => (s.length > W ? s.slice(0, W - 1) + "…" : s).padEnd(W);

      // The wordmark. A tall terminal gets the full block letters; a short one
      // gets the two-line cut, because a header must never eat the list it
      // introduces. Either way it scrolls away with the content above the fold.
      const nodes: ViewNode[] = [
        { kind: "big", text: "kona", color: ACCENT, font: innerHeight() >= 24 ? "block" : "tiny" },
        {
          kind: "text",
          text: q
            ? `${applets.length}/${total} matching “${q}”`
            : `${total} app${total === 1 ? "" : "s"} · bimodal terminal applets`,
          dim: true,
        },
        { kind: "spacer" },
      ];

      // One entry = an accented title row (glyph + name) with its summary under
      // it, dim. The selected row takes the full-width accent bar every list in
      // kona uses, and carries `focus` so setFrame scrolls it into view — which
      // is what makes the launcher survive an applet count taller than the
      // terminal.
      applets.forEach((a, i) => {
        const sel = i === cursor;
        const tint = appletAccent(a.id, a.tint ?? ACCENT);
        const icon = appletString(a.id, "icon", a.icon ?? "•");
        const title = clip(` ${sel ? "▸" : " "} ${icon}  ${a.title}`);
        nodes.push(
          sel
            ? { kind: "text", text: title, color: ON_ACCENT, bg: tint, focus: true, index: i }
            : { kind: "text", text: title, color: tint, index: i },
        );
        nodes.push({ kind: "text", text: clip(`      ${a.summary ?? ""}`), dim: true, index: i });
      });
      if (!applets.length) {
        nodes.push({ kind: "text", text: `  nothing matches “${q}” — esc clears the filter`, dim: true });
      }

      // peek 1: the selected row's summary line rides on screen with it.
      setFrame("kona", ACCENT, nodes, null, 1);
      setFooter(launcherHints());
    },
    footerNote(text, color = palette().error) {
      footer.content = new StyledText([fg(color)(text)]);
      renderer.requestRender();
    },
    searchBar(buf, placeholder, opts = {}) {
      footer.content = new StyledText(searchChunks(buf, placeholder, { ...colors, accent: ACCENT }, opts));
      renderer.requestRender();
    },
    focusedInput() {
      return focused;
    },
    setDraft(next) {
      draft = next;
    },
    scrollBy(lines) {
      scroll.scrollTop = clampScroll(scroll.scrollTop + lines, scroll.scrollHeight, scroll.viewport.height);
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
