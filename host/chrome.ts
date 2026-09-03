import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { Color } from "../sdk/index.ts";

/**
 * The frame: the chrome every applet is drawn inside.
 *
 * A bordered box that fills the terminal, a scrolling viewport for the applet's
 * body, an absolutely-positioned layer above it for overlays, and the hint bar
 * pinned below. Built once per host; the stage refills its contents each frame.
 */

export interface Chrome {
  /** The bordered box; its title and border color are the applet's. */
  frame: BoxRenderable;
  /** The applet's body. Overflow scrolls instead of collapsing children. */
  scroll: ScrollBoxRenderable;
  /** Floats over the body, hidden until an applet returns an overlay. */
  overlayLayer: BoxRenderable;
  /** The hint bar, below the frame. */
  footer: TextRenderable;
}

export function createChrome(renderer: CliRenderer, accent: Color): Chrome {
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
    borderColor: accent,
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
  // Only the vertical bar is ever wanted: the body is clamped to the pane's
  // width, so a horizontal one has nothing to scroll — and until the ScrollBox
  // works that out for itself it reserves the row anyway, which cost the FIRST
  // frame of every screen a line of viewport (the follow then scrolled against
  // a body one row shorter than every frame after it).
  scroll.horizontalScrollBar.visible = false;
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

  return { frame, scroll, overlayLayer, footer };
}

/**
 * Empty a container, destroying children so native buffers don't leak.
 *
 * `destroyRecursively`, NOT `destroy`: OpenTUI's `destroy()` frees the node's
 * own buffers and then merely REMOVES its children — it does not destroy them.
 * A view tree is nested (a board is `text` cells inside a `row` inside a `col`),
 * so destroying only the roots orphaned every leaf with its native TextBuffer
 * still allocated, and the frame after that allocated a fresh set. At one repaint
 * a second nothing showed; at a game's tick rate the allocator ran out and
 * `new TextBuffer` started throwing "Failed to create TextBuffer", which took the
 * whole TUI down mid-game (#99). Freeing the subtree is what makes a repaint cost
 * nothing that lasts.
 */
export function clearChildren(parent: { getChildren(): unknown[]; remove(child: never): void }): void {
  for (const child of [...parent.getChildren()]) {
    parent.remove(child as never);
    (child as { destroyRecursively?: () => void }).destroyRecursively?.();
  }
}
