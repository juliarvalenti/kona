import type { BoxRenderable, Renderable } from "@opentui/core";
import type { Color, Overlay, ViewNode } from "../sdk/index.ts";
import { clearChildren } from "./chrome.ts";

/**
 * The overlay layer, render side. (Its INPUT side — what the keys do while a
 * dialog is up — lives in ./input.ts.)
 *
 * The terminal has no z-axis, so the host provides one: an overlay is drawn
 * into a layer positioned over the whole content area, above it in z-order, so
 * a modal floats instead of taking part in the body's flow.
 */
export function setOverlayLayer(
  layer: BoxRenderable,
  overlay: Overlay | null,
  render: (node: ViewNode) => Renderable,
  panel: Color,
): void {
  clearChildren(layer);
  layer.visible = overlay !== null;
  // Cells have no alpha, so a scrim is an opaque fill, not a tint: it covers
  // the body rather than dimming it. Without one the layer stays transparent
  // and only the overlay node itself hides what it sits on.
  layer.backgroundColor = overlay?.scrim ? panel : "transparent";
  if (overlay) layer.add(render(overlay.node));
}
