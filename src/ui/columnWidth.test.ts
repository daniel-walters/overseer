import { describe, it, expect } from "vitest";
import { columnWidth, COLUMN_WIDTH_FLOOR } from "./columnWidth.js";

describe("columnWidth", () => {
  it("widens past the floor on a wide terminal — viewport / columnCount", () => {
    // 240 cols across 3 columns is 80 each, comfortably above the floor.
    expect(columnWidth(240, 3, 24)).toBe(80);
  });

  it("clamps to the floor on a narrow terminal — never shrinks below it", () => {
    // 60 cols across 3 is 20 each, below the floor, so it holds at 24.
    expect(columnWidth(60, 3, 24)).toBe(24);
  });

  it("returns exactly the floor at the exact-fit boundary", () => {
    // 72 cols across 3 is exactly 24 each — the floor and the share coincide.
    expect(columnWidth(72, 3, 24)).toBe(24);
  });

  it("distributes the same terminal width differently across 3 vs 8 columns", () => {
    // The board level (3) gets generous columns; the zoomed level (8) divides
    // the same viewport into narrower ones — different widths, same width in.
    const wide = 420;
    expect(columnWidth(wide, 3, 24)).toBe(140);
    expect(columnWidth(wide, 8, 24)).toBe(52);
  });

  it("clamps the 8-column zoomed level to the floor on a standard terminal", () => {
    // 8 columns at the 24 floor want 192 cols; a standard ~120-col terminal can't
    // hold them, so each holds at 24 and the row clips horizontally (deferred).
    expect(columnWidth(120, 8, 24)).toBe(24);
  });

  it("returns whole columns — never a fractional width", () => {
    // 100 / 3 = 33.33…; the layout can't render a fraction of a column.
    expect(Number.isInteger(columnWidth(100, 3, 24))).toBe(true);
  });

  it("defaults the floor to the exported 24", () => {
    expect(COLUMN_WIDTH_FLOOR).toBe(24);
    expect(columnWidth(60, 3)).toBe(24);
    expect(columnWidth(240, 3)).toBe(80);
  });
});
