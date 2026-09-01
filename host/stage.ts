import {
  TextRenderable,
  BoxRenderable,
  ASCIIFontRenderable,
  ScrollBoxRenderable,
  StyledText,
  fg,
  bold,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding, ViewNode, LayoutOpts } from "../sdk/index.ts";

/**
 * The stage: everything that turns applet view-nodes into OpenTUI renderables —
 * the bordered frame, the keybind hint bar, and the node->widget mapping. It is
 * renderer-agnostic, so the live host drives it with a real CliRenderer and the
 * snapshot tool/tests drive it with a headless test renderer.
 */

export const COLORS = {
  DIM: "#6a6a6a",
  FG: "#d0d0d0",
  ACCENT: "#7aa2f7",
  RED: "#ff5c57",
  KEY: "#e6e6e6",
};

export interface Hint {
  key: string;
  label: string;
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
        if (n.focus) found = line;
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
        for (const c of n.children) if (typeof c === "object" && c.kind === "text" && c.focus) found = line;
        line += 1;
        break;
      case "col":
        for (const c of n.children) visit(c);
        break;
    }
  };
  nodes.forEach(visit);
  return found;
}

export interface Stage {
  renderApplet(def: AppletDef, state: AppletState): void;
  renderLauncher(applets: AppletDef[], cursor: number): void;
  footerNote(text: string, color?: string): void;
  searchBar(query: string, placeholder?: string): void;
  scrollBy(lines: number): void;
  scrollTop(): number;
  viewportHeight(): number;
  hasFocusTarget(): boolean;
  resetScroll(): void;
}

export function createStage(renderer: CliRenderer): Stage {
  const { DIM, FG, ACCENT, KEY } = COLORS;

  // Inner content size = terminal size minus fixed chrome. Width: stage pad 2 +
  // border 2 + frame pad 2 + scrollbar column 1 = 7. Height: same 6 + footer 1.
  // Derived from the renderer, which knows the terminal size immediately.
  const term = renderer as unknown as { width: number; height: number };
  const innerWidth = () => Math.max(20, term.width - 7);
  const innerHeight = () => Math.max(6, term.height - 7);

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
  stage.add(frame);
  const footer = new TextRenderable(renderer, { id: "footer", content: "", paddingLeft: 1, wrapMode: "none" });
  renderer.root.add(stage);
  renderer.root.add(footer);

  function setFooter(hints: Hint[]) {
    const chunks: TextChunk[] = [];
    hints.forEach((h, i) => {
      if (i) chunks.push(fg(DIM)("    "));
      chunks.push(fg(KEY)(bold(h.key)));
      chunks.push(fg(DIM)(` ${h.label}`));
    });
    footer.content = new StyledText(chunks);
    renderer.requestRender();
  }

  // Rebuild the frame's children each render; destroy old nodes so native
  // buffers (ASCII fonts) don't leak.
  let seq = 0;
  let hasFocus = false;
  function setFrame(title: string, titleColor: string, nodes: ViewNode[]) {
    frame.title = ` ${title} `;
    frame.titleAlignment = "center";
    frame.borderColor = titleColor;
    // Preserve scroll position across rebuilds — appends (load-more) and idle
    // refreshes shouldn't jump the view back to the top. Transitions call
    // resetScroll() explicitly.
    const prevScroll = scroll.scrollTop;
    for (const child of [...scroll.content.getChildren()]) {
      scroll.content.remove(child);
      (child as { destroy?: () => void }).destroy?.();
    }
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
    renderer.requestRender();
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
        if (!node.bg) return label;
        // Wrap in a bg box so the highlight spans the FULL row width (a text
        // node's bg only paints behind its glyphs; a box fills its stretched box).
        const bar = new BoxRenderable(renderer, {
          id,
          backgroundColor: node.bg,
          flexDirection: "row",
          flexShrink: 0,
        });
        bar.add(label);
        return bar;
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
      const accent = def.accent?.(state) ?? ACCENT;
      const crumb = def.crumb?.(state);
      setFrame(crumb ? `${def.title} › ${crumb}` : def.title, accent, nodes);

      // Hint bar = navigation intents + non-nav keymap + meta back/quit.
      const nav = def.nav;
      const hints: Hint[] = [];
      if (nav?.up || nav?.down) hints.push({ key: "↑↓", label: "move" });
      if (nav?.select) hints.push({ key: "→", label: nav.selectLabel ?? "open" });
      if (def.search) hints.push({ key: "/", label: "search" });
      for (const [key, b] of Object.entries(def.keymap ?? {})) hints.push({ key, label: bindingLabel(b) });
      const canBack = nav?.canBack?.(state) ?? false;
      hints.push({ key: "←/esc", label: canBack ? (nav?.backLabel ?? "back") : "menu" });
      hints.push({ key: "ctrl+c", label: "quit" });
      setFooter(hints);
    },
    renderLauncher(applets, cursor) {
      const nodes: ViewNode[] = [{ kind: "text", text: "pick an app", dim: true }, { kind: "spacer" }];
      applets.forEach((a, i) => {
        const sel = i === cursor;
        nodes.push({ kind: "text", text: `${sel ? "▸" : " "} ${a.title}`, color: sel ? ACCENT : FG });
      });
      setFrame("kona", ACCENT, nodes);
      setFooter([
        { key: "↑/↓", label: "move" },
        { key: "enter", label: "open" },
        { key: "ctrl+c", label: "quit" },
      ]);
    },
    footerNote(text, color = COLORS.RED) {
      footer.content = new StyledText([fg(color)(text)]);
      renderer.requestRender();
    },
    searchBar(query, placeholder) {
      const shown = query.length ? query : (placeholder ?? "");
      footer.content = new StyledText([
        fg(COLORS.ACCENT)(bold("search ")),
        query.length ? fg(COLORS.FG)(shown) : fg(COLORS.DIM)(shown),
        fg(COLORS.ACCENT)("█"),
        fg(COLORS.DIM)("    enter apply · esc cancel"),
      ]);
      renderer.requestRender();
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
