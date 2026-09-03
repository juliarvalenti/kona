import type { InputNode, LayoutOpts, ViewNode } from "../sdk/index.ts";

/**
 * Reading the view tree.
 *
 * Pure questions the stage asks about a tree of `ViewNode`s before it draws
 * one: how a layout maps onto flexbox, and which leaf holds the keyboard.
 * Nothing here touches a renderer, so all of it is testable without a
 * terminal.
 *
 * What is deliberately NOT here any more is `focusLineOf` — the walk that
 * guessed which LINE the selected row would land on. Every question of that
 * shape ("how tall will this be?") is a second, quieter implementation of the
 * renderer, and it was wrong in four different ways at once: it counted
 * borders on boxes that draw none, and counted nothing at all for a `gap`, a
 * `padding` or a line long enough to wrap. The stage now asks the layout where
 * the row actually is (host/stage.ts), which cannot drift because it is the
 * same numbers the frame is drawn from.
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
