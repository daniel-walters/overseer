import { describe, it, expect } from "vitest";
import { laneHeight } from "./laneHeight.js";

/**
 * `laneHeight` is the pure chrome-subtraction half of the environmental-read
 * hook: it turns the live terminal row count into the number of card rows a lane
 * has to render in, by subtracting the fixed chrome around the cards (the column
 * heading, the App status line, and — only when zoomed into a PRD — the Issue
 * board's title row). Pulling it out as a pure function keeps the fiddly,
 * environment-coupled arithmetic testable directly and leaves `visibleWindow` a
 * pure function of a plain height.
 */
describe("laneHeight", () => {
  it("subtracts the column heading and status line at the board level", () => {
    // 20 terminal rows − 1 column heading − 1 status line = 18 card rows.
    expect(laneHeight(20, "board")).toBe(18);
  });

  it("subtracts the zoomed board title too at the issue level", () => {
    // The Issue board adds its PRD-title row above the columns, so one fewer.
    expect(laneHeight(20, "issues")).toBe(17);
  });

  it("never returns a negative height on a tiny terminal", () => {
    // A terminal shorter than the chrome would underflow; clamp to zero so the
    // window function (which treats <=0 as a single row) never sees a negative.
    expect(laneHeight(1, "board")).toBe(0);
    expect(laneHeight(0, "issues")).toBe(0);
  });

  it("recomputes for any height — the same arithmetic flows through on resize", () => {
    expect(laneHeight(50, "board")).toBe(48);
    expect(laneHeight(50, "issues")).toBe(47);
  });
});
