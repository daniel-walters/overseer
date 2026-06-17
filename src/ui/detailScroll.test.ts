import { describe, it, expect } from "vitest";
import { scrollDetail } from "./detailScroll.js";

describe("scrollDetail", () => {
  it("shows the whole body and no affordances when it fits the viewport", () => {
    const lines = ["a", "b", "c"];
    const window = scrollDetail(lines, 0, 5);
    expect(window.visible).toEqual(["a", "b", "c"]);
    expect(window.hasAbove).toBe(false);
    expect(window.hasBelow).toBe(false);
    expect(window.maxOffset).toBe(0);
  });

  it("windows a body taller than the viewport and flags more below", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const window = scrollDetail(lines, 0, 3);
    expect(window.visible).toEqual(["a", "b", "c"]);
    expect(window.hasAbove).toBe(false);
    expect(window.hasBelow).toBe(true);
    expect(window.maxOffset).toBe(2);
  });

  it("scrolls the window down and flags content above and below", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const window = scrollDetail(lines, 1, 3);
    expect(window.visible).toEqual(["b", "c", "d"]);
    expect(window.hasAbove).toBe(true);
    expect(window.hasBelow).toBe(true);
  });

  it("at the bottom flags more above but nothing below", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const window = scrollDetail(lines, 2, 3);
    expect(window.visible).toEqual(["c", "d", "e"]);
    expect(window.hasAbove).toBe(true);
    expect(window.hasBelow).toBe(false);
  });

  it("clamps an offset past the end back to the last full window", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const window = scrollDetail(lines, 99, 3);
    expect(window.visible).toEqual(["c", "d", "e"]);
    expect(window.hasBelow).toBe(false);
  });

  it("clamps a negative offset back to the start", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const window = scrollDetail(lines, -5, 3);
    expect(window.visible).toEqual(["a", "b", "c"]);
    expect(window.hasAbove).toBe(false);
  });
});
