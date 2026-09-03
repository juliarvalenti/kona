import { fg, StyledText, type CliRenderer, type Renderable } from "@opentui/core";
import { type AppletDef, type AppletState, type Overlay, type ViewNode, type InputNode } from "../sdk/index.ts";
import type { Edit } from "./editor.ts";
import { theme, appletAccent, appletString, type Theme } from "../core/config.ts";
import { fitBigFont } from "../core/fonts.ts";
import { createChrome, clearChildren } from "./chrome.ts";
import { inputChunks, inputLines, searchChunks, type Draft } from "./field.ts";
import { appletHints, fitHints, hintChunks, launcherHints, linesFor, overlayHints, fieldHints, FOOTER_MAX_LINES, type Hint } from "./hints.ts";
import { attachMouse, type ClickTarget, type StageMouse } from "./mouse.ts";
import { findFocusedInput } from "./nodes.ts";
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
export { COPY_PROMPT_KEY, LAUNCHER_COPY_PROMPT_KEY } from "./hints.ts";

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
  // The palette is re-read at the top of every frame, not captured once: the
  // theme can change under a RUNNING host (the picker previewing a preset, or
  // the config file changing on disk), and a stage that cached its colors
  // would keep drawing the old ones until you quit.
  let colors = palette();
  const repalette = () => (colors = palette());

  // Inner content size = terminal size minus fixed chrome. Width: stage pad 2 +
  // border 2 + frame pad 2 + scrollbar column 1 = 7. Height: the same 6, plus
  // however many lines the hint bar currently occupies (it wraps to two when an
  // applet has a lot of keys). Derived from the renderer, which knows the
  // terminal size immediately.
  //
  // It is an ESTIMATE, and it is only ever used BEFORE a frame exists: the
  // size hint an applet's `view(state, ctx)` gets, and the room the launcher
  // gives its wordmark. Flexbox does not have to agree with it (today it comes
  // out a line taller), so nothing that decides what is on screen may be built
  // on it — `viewportRows()` below is what the follow uses.
  const term = renderer as unknown as { width: number; height: number };
  let footerLines = 1;
  const innerWidth = () => Math.max(20, term.width - 7);
  const innerHeight = () => Math.max(6, term.height - 6 - footerLines);

  const { frame, scroll, overlayLayer, footer } = createChrome(renderer, colors.accent);

  /**
   * The body's height in lines, as the frame was actually laid out — the
   * number of rows a human can see. Read straight off the flexbox layout
   * rather than derived from the terminal: the frame is grown by flexGrow and
   * ends up a line taller than the arithmetic in `innerHeight()` predicts, and
   * a follow that scrolls against the smaller number pulls the list down while
   * there is still a row of it on screen. Falls back to the estimate before
   * the first layout, when there is nothing to measure yet.
   */
  const viewportRows = (): number => {
    const measured = Math.round(scroll.viewport.getLayoutNode().getComputedHeight());
    return measured > 0 ? measured : innerHeight();
  };

  /**
   * Which line of the CONTENT a widget sits on, summed out of the layout that
   * is about to be drawn. Wrapping, gaps, padding and borders are all counted
   * by the only thing that knows about them; nothing here has to know what a
   * `box` looks like or how wide a line wraps at.
   */
  const contentLineOf = (node: Renderable | null): number | null => {
    let line = 0;
    for (let n = node; n; n = n.parent) {
      if (n === scroll.content) return line;
      line += Math.round(n.getLayoutNode().getComputedTop());
    }
    return null; // not inside the scroll body (an overlay's field, say)
  };

  // --- One frame's worth of state. Rebuilt on every render.
  let seq = 0;
  let hasFocus = false;
  let clickTargets: ClickTarget[] = [];
  // The field with the keyboard, and the keystrokes it has taken but not yet
  // submitted. The draft lives here (not in daemon state) so typing is instant
  // and a background state push mid-word can't clobber what you typed.
  let focused: InputNode | null = null;
  let draft: Draft | null = null;
  // The widget the selected row became this frame — the thing setFrame scrolls
  // to. First focus wins, as the old line-walk did.
  let focusTarget: Renderable | null = null;
  // WHICH row that is, across frames, so the stage can tell a moved cursor
  // from a repaint of the same screen. A row identifies itself by its list
  // index when it has one (the text under a cursor changes as it moves, and
  // an applet may retitle it live), and by its text otherwise.
  let focusKey: string | null = null;
  let prevFocusKey: string | null = null;
  // Has the human moved the viewport by hand since the selection last moved?
  // A wheel scroll is a deliberate act: an idle repaint — a scrubber tick, an
  // SSE push, a poll — must not yank the view back off it. Moving the cursor
  // hands the viewport back to the follow.
  let handScrolled = false;
  // Where the viewport sat before this frame's children replaced the last
  // frame's, and how many lines under the selection have to ride with it.
  // Captured in setFrame because rebuilding the body moves the offset around
  // (an empty content pane clamps it to zero on the way through).
  let followFrom = 0;
  let followPeek = 0;

  /**
   * Put the viewport where the selection needs it, off the layout as it stands
   * RIGHT NOW — both the body's height and the row's line, so the rule is
   * never comparing a measurement with a guess.
   *
   * Idempotent on purpose: it is run from `setFrame`, and again every time the
   * ScrollBox resizes itself underneath us. The second one is not belt and
   * braces. OpenTUI refreshes a renderable's cached size at most once per
   * frame and does it parent-first, so when the body grows the ScrollBox
   * recalculates with the viewport's NEW height and the content's OLD one, and
   * re-clamps the scroll offset to a maximum that no longer exists — quietly
   * eating a line off the follow exactly when the frame just got taller (the
   * theme picker: pick a preset whose hero is a taller figlet, and its row
   * lands one line under the fold). Running again after that recalculation,
   * from numbers straight out of yoga, is what makes the answer stick.
   */
  let following = false;
  const follow = () => {
    if (following) return; // the writes below must never re-enter through a resize
    following = true;
    const vh = viewportRows();
    // Hand the scrollbar the two numbers it clamps with, rather than let it
    // read them off caches it may not have refreshed yet.
    scroll.verticalScrollBar.scrollSize = Math.round(scroll.content.getLayoutNode().getComputedHeight());
    scroll.verticalScrollBar.viewportSize = vh;
    scroll.scrollTop = handScrolled
      ? clampScroll(followFrom, scroll.scrollHeight, vh)
      : scrollToShow(followFrom, contentLineOf(focusTarget), vh, followPeek);
    following = false;
  };

  // Re-follow after the ScrollBox has resized itself, wrapping its own
  // handlers rather than replacing them: those handlers are how its scrollbars
  // learn the new geometry, and the clamp they do on the way through is the
  // thing being corrected.
  for (const part of [scroll.viewport, scroll.content]) {
    const own = part.onSizeChange;
    part.onSizeChange = function (this: typeof part) {
      own?.call(this);
      follow();
    };
  }

  const nodeToRenderable = createNodeRenderer(renderer, {
    colors: () => colors,
    width: () => innerWidth(),
    inputChunks: (node) => inputChunks(node, draft, colors),
    inputLines: (node) => inputLines(node, draft, colors),
    claim: (index, node) => clickTargets.push({ index, node }),
    focus: (widget, node) => {
      if (focusTarget) return; // first focus wins
      focusTarget = widget;
      focusKey =
        typeof node === "object" && "index" in node && node.index !== undefined
          ? `#${node.index}`
          : typeof node === "object" && node.kind === "input"
            ? `field:${node.id}`
            : `row:${typeof node === "string" ? node : node.kind === "text" ? node.text : ""}`;
    },
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
    footer.content = new StyledText(hintChunks(shown, { dim: colors.dim, key: colors.key }));
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
    focusTarget = null;
    focusKey = null;
    clearChildren(scroll.content);
    // An overlay owns the keyboard, so only ITS fields can be focused: a field
    // in the body behind a dialog must not keep typing into it.
    focused = overlay ? findFocusedInput([overlay.node]) : findFocusedInput(nodes);
    const gen = seq++;
    nodes.forEach((node, i) => scroll.content.add(nodeToRenderable(node, `n${gen}-${i}`)));

    // Scroll-to-follow-selection: only move the viewport when the focused row
    // would be off-screen — a list that fits never scrolls. Everything the rule
    // argues about is measured off this frame's own layout (see `follow`), so
    // it is talking about what the human is looking at rather than about a
    // second guess at it. `peek` keeps a launcher entry's summary line on
    // screen with the title it belongs to.
    hasFocus = focusTarget !== null;
    // A cursor that moved is back in charge of the viewport; one that didn't
    // leaves a hand-scrolled view alone (and only re-clamps it, in case the
    // content it was scrolled into just got shorter).
    if (focusKey !== prevFocusKey) handScrolled = false;
    prevFocusKey = focusKey;
    followFrom = prevScroll;
    followPeek = peek;
    renderer.root.calculateLayout();
    follow();
    // From here on `focusTarget` may pick up an overlay's field; the follow is
    // already decided, and the next frame resets it.
    setOverlayLayer(overlayLayer, overlay ?? null, (node) => nodeToRenderable(node, `ov${gen}`), colors.panel);
    renderer.requestRender();
  }

  return {
    renderApplet(def, state) {
      repalette();
      const body = def.view(state, { width: innerWidth(), height: innerHeight() });
      const nodes: ViewNode[] = Array.isArray(body) ? (body as ViewNode[]) : [body as ViewNode];
      // An applet's own accent(state) is dynamic (the timer's run/pause tint)
      // and always wins; otherwise `[applets.<id>].accent` sets the frame color.
      const accent = def.accent?.(state) ?? appletAccent(def.id, colors.accent);
      const crumb = def.crumb?.(state);
      const overlay = def.overlay?.(state) ?? null;

      // The hint bar renders the current INPUT MODE, in the same precedence the
      // host dispatches keys with: an overlay owns the keyboard, and a field
      // inside it owns the keyboard one level further down.
      //
      // It is sized BEFORE the frame because it can wrap to two lines, and how
      // tall it is is how much viewport setFrame has to scroll the selection
      // into. Measured after, an applet with a wrapping hint bar followed its
      // cursor one line short and parked the selected row just under the fold.
      const focus = overlay ? findFocusedInput([overlay.node]) : findFocusedInput(nodes);
      if (overlay) setFooter(overlayHints(overlay, focus));
      else if (focus) setFooter(fieldHints(focus));
      else setFooter(appletHints(def, state));

      setFrame(crumb ? `${def.title} › ${crumb}` : def.title, accent, nodes, overlay);
    },
    renderLauncher(applets, cursor, opts = {}) {
      repalette();
      const W = innerWidth();
      const total = opts.total ?? applets.length;
      const q = opts.query ?? "";
      const clip = (s: string) => (s.length > W ? s.slice(0, W - 1) + "…" : s).padEnd(W);

      // The wordmark, lettered in the theme's figlet like every other hero —
      // switching theme re-letters it, not just recolors it. What the launcher
      // keeps is its own rule about SIZE: a header must never eat the list it
      // introduces, so a short terminal gets the two-line cut and a tall one
      // gives the wordmark at most a third of the pane. Either way it scrolls
      // away with the content above the fold.
      const room = innerHeight();
      const wordmark = fitBigFont("kona", colors.font, {
        width: W,
        height: room >= 24 ? Math.max(6, Math.floor(room / 3)) : 2,
      });
      const nodes: ViewNode[] = [
        { kind: "big", text: "kona", color: colors.accent, font: wordmark },
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
        const tint = appletAccent(a.id, a.tint ?? colors.accent);
        const icon = appletString(a.id, "icon", a.icon ?? "•");
        const title = clip(` ${sel ? "▸" : " "} ${icon}  ${a.title}`);
        nodes.push(
          sel
            ? { kind: "text", text: title, color: colors.bg, bg: tint, focus: true, index: i }
            : { kind: "text", text: title, color: tint, index: i },
        );
        nodes.push({ kind: "text", text: clip(`      ${a.summary ?? ""}`), dim: true, index: i });
      });
      if (!applets.length) {
        nodes.push({ kind: "text", text: `  nothing matches “${q}” — esc clears the filter`, dim: true });
      }

      // peek 1: the selected row's summary line rides on screen with it.
      setFrame("kona", colors.accent, nodes, null, 1);
      setFooter(launcherHints());
    },
    footerNote(text, color = palette().error) {
      footer.content = new StyledText([fg(color)(text)]);
      renderer.requestRender();
    },
    searchBar(buf, placeholder, opts = {}) {
      footer.content = new StyledText(searchChunks(buf, placeholder, colors, opts));
      renderer.requestRender();
    },
    focusedInput() {
      return focused;
    },
    setDraft(next) {
      draft = next;
    },
    scrollBy(lines) {
      scroll.scrollTop = clampScroll(scroll.scrollTop + lines, scroll.scrollHeight, viewportRows());
      handScrolled = true;
      followFrom = scroll.scrollTop; // a re-follow must not undo what a human did
      renderer.requestRender();
    },
    scrollTop() {
      return scroll.scrollTop;
    },
    onMouse(handler) {
      onMouseGesture = handler;
    },
    viewportHeight() {
      return viewportRows();
    },
    hasFocusTarget() {
      return hasFocus;
    },
    resetScroll() {
      handScrolled = false;
      followFrom = 0;
      scroll.scrollTop = 0;
      renderer.requestRender();
    },
  };
}
