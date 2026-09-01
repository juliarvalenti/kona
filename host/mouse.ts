import type { CliRenderer, MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";

/**
 * The mouse, resolved against what is on screen — the host never sees raw
 * coordinates.
 *
 * Rows register themselves as click targets while the frame is built, so a
 * click resolves by hit-testing the actual renderables: no screen-line
 * arithmetic, and wrapping/scrolling are handled for free.
 */

/** A selectable row and the renderable it was drawn as. */
export interface ClickTarget {
  index: number;
  node: Renderable;
}

/**
 * A mouse gesture, already resolved. `index` is the selectable row under the
 * pointer (the `index` its view node carried), null when the click missed
 * every row.
 */
export interface StageMouse {
  kind: "click" | "wheel";
  index: number | null;
  /** Wheel movement in lines: negative up, positive down. Zero for a click. */
  lines: number;
}

const WHEEL_LINES = 3;

/** The selectable row at a screen y, or null (chrome, gaps, plain text). */
export function hitTest(
  y: number,
  viewport: { screenY: number; height: number },
  targets: ClickTarget[],
): number | null {
  // Rows scrolled out of the viewport keep their (off-screen) coordinates.
  if (y < viewport.screenY || y >= viewport.screenY + viewport.height) return null;
  for (const t of targets) {
    if (t.node.isDestroyed) continue;
    if (y >= t.node.screenY && y < t.node.screenY + t.node.height) return t.index;
  }
  return null;
}

/**
 * Wire the terminal's mouse reports to resolved gestures. `targets` is read at
 * event time because the frame rebuilds them every render.
 */
export function attachMouse(
  renderer: CliRenderer,
  scroll: ScrollBoxRenderable,
  targets: () => ClickTarget[],
  emit: (e: StageMouse) => void,
): void {
  const wheel = (e: MouseEvent): boolean => {
    const dir = e.scroll?.direction;
    if (dir !== "up" && dir !== "down") return false;
    const ticks = Math.max(1, e.scroll?.delta ?? 1);
    emit({ kind: "wheel", index: null, lines: (dir === "up" ? -1 : 1) * WHEEL_LINES * ticks });
    return true;
  };

  // Take the wheel before it reaches the ScrollBox, so it moves the viewport in
  // steady whole-line steps rather than ScrollBox's own accelerated scrolling —
  // and so the host stays the one place that decides what an input means.
  scroll.content.onMouse = (e: MouseEvent) => {
    if (e.type === "scroll" && wheel(e)) e.stopPropagation();
  };

  // Everything else bubbles to the root: clicks anywhere, plus a wheel over the
  // chrome (border, footer) that never passed through the content box.
  renderer.root.onMouse = (e: MouseEvent) => {
    if (e.type === "down" && e.button === 0) {
      emit({ kind: "click", index: hitTest(e.y, scroll.viewport, targets()), lines: 0 });
    } else if (e.type === "scroll") wheel(e);
  };
}
