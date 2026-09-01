import type { InputNode, LayoutOpts, ViewNode } from "../sdk/index.ts";
import { theme } from "../core/config.ts";
import { fitBigFont, fontLines, type BigFont } from "../core/fonts.ts";

/**
 * Reading the view tree.
 *
 * Pure questions the stage asks about a tree of `ViewNode`s before it draws
 * one: how a layout maps onto flexbox, which field holds the keyboard, and
 * where the focused row sits. Nothing here touches a renderer, so all of it is
 * testable without a terminal.
 */

const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
} as const;

/** The SDK's layout knobs as the flexbox props OpenTUI takes. */
export function layoutProps(o: LayoutOpts) {
  return {
    ...(o.align ? { alignItems: ALIGN[o.align] } : {}),
    ...(o.justify ? { justifyContent: JUSTIFY[o.justify] } : {}),
    ...(o.gap !== undefined ? { gap: o.gap } : {}),
    ...(o.padding !== undefined ? { padding: o.padding } : {}),
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.grow ? { flexGrow: 1 } : {}),
  };
}

/** Focusable leaves: a selected list row, or the text field with the keyboard. */
export const isFocused = (n: ViewNode): boolean =>
  typeof n === "object" && (n.kind === "text" || n.kind === "input") && !!n.focus;

/** Lines a field occupies on screen: one, or as many as a textarea asks for. */
export const fieldRows = (f: InputNode): number => (f.multiline ? Math.max(1, f.rows ?? 6) : 1);

/**
 * How many lines a hero draws — its own figlet, the theme's when it names none,
 * and the narrower one the host falls back to when `width` says it wouldn't
 * fit. The focus math below counts lines, so a hero has to be counted at the
 * height it is ACTUALLY drawn at: a `tiny` wordmark billed as six lines would
 * push every row below it off by four.
 */
export function bigLines(node: { text: string; font?: BigFont }, width?: number): number {
  const want = node.font ?? theme().font;
  return fontLines(width === undefined ? want : fitBigFont(node.text, want, { width }));
}

/**
 * Line offset of the focused node (the selected list row), so the host can
 * scroll it into view. Approximate heights in lines — good enough because focus
 * only lives on single-line rows in a column. `width` is the pane's, and only
 * matters above a hero: it is what tells a `big` node which figlet it will be
 * drawn in, and so how many lines it pushes the rows below it down by.
 */
export function focusLineOf(nodes: ViewNode[], width?: number): number | null {
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
        if (isFocused(n)) found = line;
        line += 1;
        break;
      case "input":
        if (isFocused(n)) found = line;
        line += fieldRows(n);
        break;
      case "spacer":
      case "bar":
        line += 1;
        break;
      case "big":
        line += bigLines(n, width);
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
export function findFocusedInput(nodes: ViewNode[]): InputNode | null {
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
