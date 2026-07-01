/**
 * The floor every column holds at, in terminal cells. This is the width every
 * column was hardcoded to before adaptive width landed, so anchoring the floor
 * here means adaptive width only ever *widens* a column beyond today's layout —
 * never narrows one. No terminal regresses below what it shows today.
 */
export const COLUMN_WIDTH_FLOOR = 24;

/**
 * The width one kanban column should take, in terminal cells: the viewport
 * shared evenly across the visible columns, clamped up to the floor —
 * `max(floor, viewport / columnCount)`. A pure function of its inputs (no
 * terminal needed), so the distribution math is unit-testable directly.
 *
 * On a roomy terminal the share exceeds the floor and titles breathe; on a
 * narrow one (or the 8-column zoomed Issue level, which wants 8×24 = 192 cells
 * a standard terminal can't give) the share falls below the floor and every
 * column holds at the floor instead. When the floor's total then exceeds the
 * viewport, the row simply clips horizontally at the screen edge — the same
 * clipping the board already accepts vertically on the alt screen. Horizontal
 * scrolling / paging across columns is deliberately out of scope here; it is the
 * deferred viewport-scrolling work, its own piece.
 *
 * The result is floored to a whole number: the layout renders cells, not
 * fractions of one.
 */
export function columnWidth(
  terminalWidth: number,
  columnCount: number,
  floor: number = COLUMN_WIDTH_FLOOR,
): number {
  const share = Math.floor(terminalWidth / columnCount);
  return Math.max(floor, share);
}
