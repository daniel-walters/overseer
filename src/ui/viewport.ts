/**
 * Vertical selection-following viewport scroll, kept as a pure function with no
 * Ink or Board dependency (ADR 0015). Given a lane's available row height, its
 * card count, and the selected row, {@link visibleWindow} returns the half-open
 * slice `[start, end)` of cards the lane should render. The Column renders only
 * that slice, so a lane taller than the screen scrolls to keep the selection in
 * view instead of clipping unreachable cards.
 *
 * The chrome subtraction that turns a raw terminal size into a plain available
 * height lives in the environmental-read helper (`laneHeight`), so this stays a
 * pure function of a plain height — trivially unit-testable, and a resize is just
 * a different height number flowing in.
 */

/** A half-open `[start, end)` slice of a lane's cards to render. */
export interface Window {
  readonly start: number;
  readonly end: number;
}

/**
 * The visible slice of a lane's cards.
 *
 * - A lane that fits the height returns its whole range (`{ start: 0, end:
 *   cardCount }`) — no scroll.
 * - An overflowing lane returns a `laneHeight`-sized window that centres
 *   `selectedRow`, clamped so it never runs past either end of the lane. Centring
 *   keeps the selection off the window's edge with a band of context above and
 *   below (scrolloff-style) rather than jammed against it; the clamp is what pins
 *   the window to the lane's top at the first rows and to its bottom at the last,
 *   where there's nothing past the edge to show.
 *
 * A non-positive height (chrome can eat the whole screen on a tiny terminal) is
 * treated as room for a single row, so the result is always a renderable,
 * non-inverted slice containing the selection.
 */
export function visibleWindow(
  laneHeight: number,
  cardCount: number,
  selectedRow: number,
): Window {
  if (cardCount <= 0) return { start: 0, end: 0 };

  // Chrome can drive the available height to zero or below; render at least the
  // selected row so no card is ever unreachable.
  const height = Math.max(1, Math.floor(laneHeight));

  // The lane fits — show all of it, no scroll.
  if (cardCount <= height) return { start: 0, end: cardCount };

  // Centre the selection in the window: `floor(height / 2)` rows of context sit
  // above it (and the rest below). With the lane overflowing on both sides this
  // keeps the selection off either edge — the scrolloff context the criteria
  // call for — rather than jamming it against the top or bottom.
  let start = selectedRow - Math.floor(height / 2);

  // Clamp into the valid range `[0, cardCount - height]`. This is what pins the
  // window to the lane's top while the selection is in the first rows and to its
  // bottom in the last rows: there's nothing past those edges to show, so the
  // centre bias yields to the lane bounds and the selection moves toward the edge
  // of a stationary window.
  start = Math.max(0, Math.min(start, cardCount - height));

  return { start, end: start + height };
}
