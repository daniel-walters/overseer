/**
 * The pure windowing core behind the detail modal's scrolling: given the body's
 * already-rendered terminal lines, a scroll offset, and how many rows the body
 * region can show, project the window to render plus the overflow affordances.
 *
 * Scrolling operates on the *rendered* lines (markdown → lines → window), not the
 * raw source, so formatted output scrolls correctly. This module is the App and
 * the {@link DetailModal}'s single source of truth: the App clamps a keypress with
 * {@link ScrollWindow.maxOffset}, the modal renders {@link ScrollWindow.visible}
 * and shows the affordances — both call this one function so the two can't drift.
 */

/** A windowed view of the body's rendered lines plus its scroll affordances. */
export interface ScrollWindow {
  /** The slice of lines that fits the viewport at this offset. */
  readonly visible: readonly string[];
  /** There are clipped lines above the window (offset is past the start). */
  readonly hasAbove: boolean;
  /** There are clipped lines below the window (more body to scroll to). */
  readonly hasBelow: boolean;
  /** The furthest the offset can move — the last row that keeps the window full. */
  readonly maxOffset: number;
}

/**
 * Window `lines` for a body region of `viewportRows` rows at scroll `offset`.
 *
 * `offset` is clamped to `[0, maxOffset]` so a window is always valid even if the
 * caller hands a stale offset (e.g. the body shrank under it). When the whole body
 * fits, `maxOffset` is 0 and both affordances are false — the fits-the-viewport
 * case that shows no chrome and ignores scroll keys.
 */
export function scrollDetail(
  lines: readonly string[],
  offset: number,
  viewportRows: number,
): ScrollWindow {
  const rows = Math.max(0, viewportRows);
  const maxOffset = Math.max(0, lines.length - rows);
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  return {
    visible: lines.slice(clamped, clamped + rows),
    hasAbove: clamped > 0,
    hasBelow: clamped < maxOffset,
    maxOffset,
  };
}
