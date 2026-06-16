import type { Level } from "./navigation.js";

/**
 * The chrome-subtraction half of the environmental-read for vertical viewport
 * scroll (ADR 0015): turn the live terminal row count into each lane's available
 * card-row height, which {@link import("./viewport.js").visibleWindow} slices the
 * lane against.
 *
 * The reactive size read itself is Ink's `useWindowSize`, already subscribed in
 * the {@link import("./App.js").App} (it pins the root box to the window height);
 * that one read *is* the environmental read, and a terminal resize (SIGWINCH)
 * re-renders it, flowing a new height through {@link laneHeight} and recomputing
 * every lane's window for free. This module holds only the fiddly,
 * environment-coupled chrome arithmetic — pulled out as a pure function so it is
 * testable directly and so `visibleWindow` stays a pure function of a plain
 * height number.
 *
 * This is the vertical twin of the adaptive-column-*width* read the
 * `title-legibility` PRD adds (the same terminal-size read, `columns` rather than
 * `rows`); if that PRD's hook lands first the two reads coalesce, but the chrome
 * arithmetic stays its own pure helper either way.
 */

/** The column heading row {@link import("./Column.js").Column} renders above its cards. */
const COLUMN_HEADING_ROWS = 1;

/** The persistent App status line pinned to the bottom row. */
const STATUS_LINE_ROWS = 1;

/** The Issue board's PRD-title row, present only while zoomed into a PRD. */
const ISSUE_TITLE_ROWS = 1;

/**
 * The number of card rows a lane has to render in, given the terminal's row
 * count and which level is on screen. Subtracts the fixed chrome around the
 * cards — the column heading and the App status line at both levels, plus the
 * Issue board's title row when zoomed — and never goes below zero, so a terminal
 * shorter than the chrome yields an empty (not negative) height that
 * `visibleWindow` degrades to a single visible row.
 */
export function laneHeight(rows: number, level: Level): number {
  const chrome =
    COLUMN_HEADING_ROWS +
    STATUS_LINE_ROWS +
    (level === "issues" ? ISSUE_TITLE_ROWS : 0);
  return Math.max(0, rows - chrome);
}
