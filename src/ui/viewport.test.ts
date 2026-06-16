import { describe, it, expect } from "vitest";
import { visibleWindow } from "./viewport.js";

/**
 * `visibleWindow` is the pure core of vertical selection-following scroll: given
 * a lane's available row height, its card count, and the selected row, it returns
 * the half-open slice `[start, end)` of cards to render. Scrolloff-style — the
 * selection is kept off the very edge when there's room — so these assertions
 * pin both the slice bounds and that the selected row always lands inside them.
 */
describe("visibleWindow", () => {
  it("shows the whole lane when it fits the available height", () => {
    // Five cards, room for ten: no scroll, the full lane is the window.
    expect(visibleWindow(10, 5, 0)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(10, 5, 4)).toEqual({ start: 0, end: 5 });
  });

  it("shows the whole lane when it exactly fills the height", () => {
    expect(visibleWindow(5, 5, 2)).toEqual({ start: 0, end: 5 });
  });

  it("centres a mid-lane selection with context above and below", () => {
    // Height 5, 20 cards, selection at row 10. The selection sits in the middle of
    // the window with context on both sides — not jammed against either edge.
    const win = visibleWindow(5, 20, 10);
    expect(win.end - win.start).toBe(5);
    expect(win.start).toBeLessThan(10);
    expect(win.end - 1).toBeGreaterThan(10);
    expect(win).toEqual({ start: 8, end: 13 });
  });

  it("keeps the selection in view with context as it moves down past the edge", () => {
    // Selecting deeper than the top-anchored window can show scrolls the window
    // down so the selection stays centred (context above and below preserved).
    const win = visibleWindow(5, 20, 6);
    expect(win.end - win.start).toBe(5);
    expect(win.start).toBeLessThan(6);
    expect(win.end - 1).toBeGreaterThan(6);
    expect(win).toEqual({ start: 4, end: 9 });
  });

  it("pins the window to the top at the first row", () => {
    expect(visibleWindow(5, 20, 0)).toEqual({ start: 0, end: 5 });
    // A row still within half a window of the top can't be centred without
    // scrolling past the top, so the window stays pinned there.
    expect(visibleWindow(5, 20, 1)).toEqual({ start: 0, end: 5 });
  });

  it("pins the window to the bottom at the last row", () => {
    // The last row can't be centred — there's nothing below to fill the lower
    // half — so the window clamps to the bottom of the lane rather than scrolling
    // past it. The selection is in view, at the window's edge, with no card hidden.
    expect(visibleWindow(5, 20, 19)).toEqual({ start: 15, end: 20 });
  });

  it("never scrolls past the bottom of the lane", () => {
    // Selection at row 18 (one off the end): centring would want start 16, but the
    // window must not run past card 20, so it clamps to the bottom.
    const win = visibleWindow(5, 20, 18);
    expect(win.end).toBeLessThanOrEqual(20);
    expect(win.start).toBeGreaterThanOrEqual(0);
    expect(win.end - win.start).toBe(5);
    expect(win).toEqual({ start: 15, end: 20 });
  });

  it("handles a height of one — only the selected row is visible", () => {
    expect(visibleWindow(1, 20, 7)).toEqual({ start: 7, end: 8 });
  });

  it("handles an empty lane", () => {
    expect(visibleWindow(5, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it("treats a non-positive height as room for a single row", () => {
    // Chrome subtraction can drive the available height to zero on a tiny
    // terminal; the window must still resolve to a renderable single-row slice
    // around the selection rather than an empty or inverted range.
    const win = visibleWindow(0, 20, 7);
    expect(win.start).toBeLessThanOrEqual(7);
    expect(win.end).toBeGreaterThan(7);
    expect(win.end - win.start).toBe(1);
  });
});
