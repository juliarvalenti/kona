/**
 * Scrolling arithmetic — where the viewport should sit, as pure numbers.
 *
 * Two rules, both easy to get subtly wrong (and both regressions we have
 * already had): a list that fits never scrolls, and the selected row is always
 * on screen. Keeping them here means they can be tested without a terminal.
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
 */
export function scrollToShow(top: number, focusLine: number | null, viewportHeight: number): number {
  if (focusLine === null) return Math.max(0, top);
  if (focusLine < top) return Math.max(0, focusLine);
  if (focusLine > top + viewportHeight - 1) return Math.max(0, focusLine - viewportHeight + 1);
  return Math.max(0, top);
}
