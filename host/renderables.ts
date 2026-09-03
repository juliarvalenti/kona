import {
  ASCIIFontRenderable,
  BoxRenderable,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import type { BigFont, Color, InputNode, ViewNode } from "../sdk/index.ts";
import { fitBigFont } from "../core/fonts.ts";
import { isFocused, layoutProps } from "./nodes.ts";

/**
 * The node -> renderable mapping: the ONE place that knows how a `ViewNode`
 * becomes an OpenTUI widget. Everything an applet can draw is here and nothing
 * else is — chrome (frame, footer, overlay layer) lives with the stage.
 */

/** The theme roles the mapping paints with — and letters with. */
export interface NodeColors {
  fg: Color;
  dim: Color;
  accent: Color;
  /** The figlet a `big` node with no font of its own is drawn in. */
  font: BigFont;
}

export interface NodeRendererOpts {
  /** Read per node, not captured: the palette can change between frames. */
  colors: () => NodeColors;
  /** Cells the pane is wide — the budget a hero has to fit inside. */
  width: () => number;
  /** A field as styled cells; the stage owns the in-flight draft. */
  inputChunks: (node: InputNode) => TextChunk[];
  /** A textarea as a stack of one-line cell rows (the editor owns the wrap). */
  inputLines: (node: InputNode) => TextChunk[][];
  /** Register a row as a mouse target (it carried an `index`). */
  claim: (index: number, node: Renderable) => void;
  /**
   * Hand back the widget a FOCUSED node became, with the node itself. This is
   * how the stage finds the selected row without predicting where it will
   * land: it scrolls to the thing it just built, wherever the layout ends up
   * putting it — and the node is what tells it, next frame, whether the
   * selection MOVED or the screen merely repainted.
   */
  focus: (widget: Renderable, node: ViewNode) => void;
}

// Sub-cell resolution for `bar`: full blocks + one fractional block = 8x
// smoother, so slow bars visibly move instead of looking frozen.
const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Build the mapping for one renderer. Returns `nodeToRenderable(node, id)`;
 * `id` is a per-frame path (`n7-2.1`) so rebuilt nodes never collide.
 */
export function createNodeRenderer(
  renderer: CliRenderer,
  { colors, width, inputChunks, inputLines, claim, focus }: NodeRendererOpts,
): (node: ViewNode, id: string) => Renderable {
  function nodeToRenderable(node: ViewNode, id: string): Renderable {
    const { fg: FG, dim: DIM, accent: ACCENT, font: FONT } = colors();
    // flexShrink:0 everywhere — leaves must keep their height so they never
    // collapse on top of each other when content exceeds the viewport.
    if (typeof node === "string") return new TextRenderable(renderer, { id, content: node, fg: FG, wrapMode: "word", flexShrink: 0 });
    switch (node.kind) {
      case "big": {
        // The figlet is a theme role: a node names one only when its layout
        // depends on that face, and otherwise gets the theme's. Either way the
        // PANE has the last word — figlets differ enough in width (60 cells for
        // "00:00" in `huge`, 17 in `tiny`) that a hero drawn at face value
        // would run off the side of most terminals — so the widest figlet that
        // fits is what actually gets drawn.
        const font = fitBigFont(node.text, node.font ?? FONT, { width: width() });
        return new ASCIIFontRenderable(renderer, { id, text: node.text, font, color: node.color ?? FG, flexShrink: 0 });
      }
      case "text": {
        const label = new TextRenderable(renderer, {
          id: node.bg ? `${id}-t` : id,
          content: node.text,
          fg: node.dim ? DIM : (node.color ?? FG),
          ...(node.bg ? { bg: node.bg } : {}),
          wrapMode: "word",
          flexShrink: 0,
        });
        const claimed = (n: Renderable) => {
          if (node.index !== undefined) claim(node.index, n);
          // The OUTERMOST widget, so a selected row reports the full-width
          // highlight bar rather than the label sitting inside it.
          if (isFocused(node)) focus(n, node);
          return n;
        };
        if (!node.bg) return claimed(label);
        // Wrap in a bg box so the highlight spans the FULL row width (a text
        // node's bg only paints behind its glyphs; a box fills its stretched box).
        const bar = new BoxRenderable(renderer, {
          id,
          backgroundColor: node.bg,
          flexDirection: "row",
          flexShrink: 0,
        });
        bar.add(label);
        return claimed(bar);
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
      case "input": {
        const focused = (n: Renderable) => {
          if (isFocused(node)) focus(n, node);
          return n;
        };
        if (!node.multiline)
          return focused(
            new TextRenderable(renderer, {
              id,
              content: new StyledText(inputChunks(node)),
              wrapMode: "none",
              flexShrink: 0,
            }),
          );
        // A textarea is a stack of one-line renderables: the wrapping is the
        // editor's (it owns the caret's row and column), never OpenTUI's.
        const area = new BoxRenderable(renderer, { id, flexDirection: "column", flexShrink: 0 });
        inputLines(node).forEach((chunks, i) =>
          area.add(
            new TextRenderable(renderer, {
              id: `${id}.l${i}`,
              content: new StyledText(chunks),
              wrapMode: "none",
              flexShrink: 0,
            }),
          ),
        );
        return focused(area);
      }
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
        const eighths = Math.round(node.value * width * 8);
        const full = Math.floor(eighths / 8);
        const partial = PARTIALS[eighths % 8]!;
        const content = ("█".repeat(full) + partial).padEnd(width, "░");
        return new TextRenderable(renderer, { id, content, fg: node.color ?? FG });
      }
    }
  }

  return nodeToRenderable;
}
