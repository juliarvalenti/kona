/**
 * Scrolling arithmetic — where the viewport should sit, as pure numbers.
 *
 * Two rules, both easy to get subtly wrong (and both regressions we have
 * already had): a list that fits never scrolls, and the selected row is always
 * on screen. Keeping them here means they can be tested without a terminal.
 *
 * This is THE follow, not a documented copy of it: the stage calls
 * `scrollToShow` on every frame. It used to keep its own inline version, which
 * is how the rule stayed green here for months while the screen misbehaved —
 * so if you are about to write `if (focusLine < top)` anywhere else, don't.
 * Both numbers it is given are MEASURED off the frame the renderer just laid
 * out (host/stage.ts), never predicted from the view tree: everything that has
 * ever gone wrong with kona's scrolling went wrong in that prediction.
 */

/** Clamp a scroll offset to [0, maxScroll] — never into empty space below. */
export function clampScroll(top: number, contentHeight: number, viewportHeight: number): number {
  const max = Math.max(0, contentHeight - viewportHeight);
  return Math.max(0, Math.min(max, top));
}

/**
 * Scroll-to-follow-selection: move the viewport only when the focused row would
 * be off-screen, so a list that fits never jumps. `focusLine` is null when
 * nothing is focused, and then the current offset stands (an append or an idle
 * refresh must not yank the view back to the top).
 *
 * `peek` is how many lines BELOW the focused one must stay on screen with it —
 * the launcher's rows carry a summary underneath, and following the title alone
 * would leave it hanging off the bottom edge.
 */
export function scrollToShow(
  top: number,
  focusLine: number | null,
  viewportHeight: number,
  peek = 0,
): number {
  if (focusLine === null) return Math.max(0, top);
  if (focusLine < top) return Math.max(0, focusLine);
  const lastVisible = top + viewportHeight - 1;
  if (focusLine + peek > lastVisible) return Math.max(0, focusLine + peek - viewportHeight + 1);
  return Math.max(0, top);
}
