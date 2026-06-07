import { describe, it, expect } from "vitest";
import { initialNav, navReduce, type NavState } from "./navigation.js";

describe("navigation", () => {
  it("starts at the board level with the first card selected", () => {
    expect(initialNav).toEqual({
      level: "board",
      boardIndex: 0,
      issueIndex: 0,
    });
  });

  it("moves the board selection within bounds", () => {
    const moved = navReduce(initialNav, { type: "move", delta: 1, count: 3 });
    expect(moved.boardIndex).toBe(1);
  });

  it("clamps board selection at the top and bottom rather than wrapping", () => {
    const atTop = navReduce(initialNav, { type: "move", delta: -1, count: 3 });
    expect(atTop.boardIndex).toBe(0);

    const atBottom = navReduce(
      { ...initialNav, boardIndex: 2 },
      { type: "move", delta: 1, count: 3 },
    );
    expect(atBottom.boardIndex).toBe(2);
  });

  it("moves the issue selection while zoomed, leaving boardIndex untouched", () => {
    const zoomed: NavState = { level: "issues", boardIndex: 1, issueIndex: 0 };
    const moved = navReduce(zoomed, { type: "move", delta: 1, count: 2 });
    expect(moved.issueIndex).toBe(1);
    expect(moved.boardIndex).toBe(1);
  });

  it("zooms from the board into the selected PRD's Issues, selecting the first", () => {
    const zoomed = navReduce(
      { ...initialNav, boardIndex: 2 },
      { type: "zoom", issueCount: 4 },
    );
    expect(zoomed.level).toBe("issues");
    expect(zoomed.boardIndex).toBe(2);
    expect(zoomed.issueIndex).toBe(0);
  });

  it("backs out from Issues to the board, preserving the PRD selection", () => {
    const backed = navReduce(
      { level: "issues", boardIndex: 2, issueIndex: 3 },
      { type: "back" },
    );
    expect(backed.level).toBe("board");
    expect(backed.boardIndex).toBe(2);
  });

  it("treats back at the board level as a no-op", () => {
    expect(navReduce(initialNav, { type: "back" })).toBe(initialNav);
  });

  it("ignores a zoom request that arrives while already zoomed", () => {
    const zoomed: NavState = { level: "issues", boardIndex: 0, issueIndex: 1 };
    expect(navReduce(zoomed, { type: "zoom", issueCount: 5 })).toBe(zoomed);
  });
});
