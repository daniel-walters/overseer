import { describe, it, expect } from "vitest";
import {
  initialNav,
  navReduce,
  selectedCoord,
  type NavState,
  type Coord,
} from "./navigation.js";

/** A board-level coordinate at lane/row, defaulting desiredRow to rowIndex. */
function coord(laneIndex: number, rowIndex: number, desiredRow = rowIndex): Coord {
  return { laneIndex, rowIndex, desiredRow };
}

/** A board-level NavState pinned at the given coordinate. */
function boardAt(laneIndex: number, rowIndex: number, desiredRow = rowIndex): NavState {
  return {
    level: "board",
    board: coord(laneIndex, rowIndex, desiredRow),
    issues: coord(0, 0),
    confirming: false,
  };
}

/** A zoomed (Issue-level) NavState pinned at the given Issue coordinate. */
function issuesAt(laneIndex: number, rowIndex: number, desiredRow = rowIndex): NavState {
  return {
    level: "issues",
    board: coord(0, 0),
    issues: coord(laneIndex, rowIndex, desiredRow),
    confirming: false,
  };
}

describe("navigation", () => {
  it("starts at the board level with the first lane/row selected", () => {
    expect(initialNav).toEqual({
      level: "board",
      board: { laneIndex: 0, rowIndex: 0, desiredRow: 0 },
      issues: { laneIndex: 0, rowIndex: 0, desiredRow: 0 },
      confirming: false,
    });
  });

  describe("vertical movement (j/k within a lane)", () => {
    it("moves the board selection down a row within bounds", () => {
      // One lane with three cards.
      const moved = navReduce(initialNav, { type: "move", dir: "down", lanes: [3] });
      expect(moved.board.rowIndex).toBe(1);
      expect(moved.board.laneIndex).toBe(0);
    });

    it("moves the board selection up a row", () => {
      const up = navReduce(boardAt(0, 2), { type: "move", dir: "up", lanes: [3] });
      expect(up.board.rowIndex).toBe(1);
    });

    it("clamps at the top and bottom of a lane rather than wrapping", () => {
      const atTop = navReduce(initialNav, { type: "move", dir: "up", lanes: [3] });
      expect(atTop.board.rowIndex).toBe(0);

      const atBottom = navReduce(boardAt(0, 2), { type: "move", dir: "down", lanes: [3] });
      expect(atBottom.board.rowIndex).toBe(2);
    });

    it("j and k move the row, leaving the lane untouched", () => {
      const down = navReduce(boardAt(1, 0), { type: "move", dir: "down", lanes: [2, 3] });
      expect(down.board).toMatchObject({ laneIndex: 1, rowIndex: 1 });
    });

    it("records the live row as the desired row on a vertical move", () => {
      const moved = navReduce(initialNav, { type: "move", dir: "down", lanes: [3] });
      expect(moved.board.desiredRow).toBe(1);
    });

    it("moves the issue row while zoomed, leaving the board coordinate untouched", () => {
      const zoomed = issuesAt(1, 0);
      const moved = navReduce(zoomed, { type: "move", dir: "down", lanes: [0, 2] });
      expect(moved.issues).toMatchObject({ laneIndex: 1, rowIndex: 1 });
      expect(moved.board).toEqual(zoomed.board);
    });

    it("moves down within the displayed lane when the stored lane is empty", () => {
      // The stored lane 0 is empty, so the selection *displays* on the first
      // non-empty lane (lane 1, where the cards are). `j` must move down that
      // displayed lane — not no-op against the empty stored lane.
      const moved = navReduce(boardAt(0, 0), { type: "move", dir: "down", lanes: [0, 2] });
      expect(moved.board).toMatchObject({ laneIndex: 1, rowIndex: 1 });
    });
  });

  describe("horizontal movement (h/l across lanes)", () => {
    it("l selects the lane to the right; h the lane to the left", () => {
      const right = navReduce(boardAt(0, 0), { type: "move", dir: "right", lanes: [1, 1, 1] });
      expect(right.board.laneIndex).toBe(1);

      const left = navReduce(boardAt(2, 0), { type: "move", dir: "left", lanes: [1, 1, 1] });
      expect(left.board.laneIndex).toBe(1);
    });

    it("clamps at the first and last lane rather than wrapping", () => {
      const atLeft = navReduce(boardAt(0, 0), { type: "move", dir: "left", lanes: [1, 1, 1] });
      expect(atLeft.board.laneIndex).toBe(0);

      const atRight = navReduce(boardAt(2, 0), { type: "move", dir: "right", lanes: [1, 1, 1] });
      expect(atRight.board.laneIndex).toBe(2);
    });

    it("skips an empty lane, landing on the next lane that has a card", () => {
      // Lanes: [2, 0, 2]. From lane 0, `l` skips the empty middle lane to lane 2.
      const right = navReduce(boardAt(0, 0), { type: "move", dir: "right", lanes: [2, 0, 2] });
      expect(right.board.laneIndex).toBe(2);
    });

    it("is a no-op when every lane to the side is empty", () => {
      // From lane 0, lanes 1 and 2 are empty: `l` cannot land anywhere.
      const state = boardAt(0, 0);
      const right = navReduce(state, { type: "move", dir: "right", lanes: [2, 0, 0] });
      expect(right).toBe(state);
    });

    it("clamps the landing row to the target lane's height", () => {
      // Lane 0 has 4 cards (row 3 selected); lane 1 has 2. Moving right clamps to row 1.
      const right = navReduce(boardAt(0, 3), { type: "move", dir: "right", lanes: [4, 2] });
      expect(right.board.rowIndex).toBe(1);
    });

    it("returns to the original row on a tall → short → tall round-trip (sticky desiredRow)", () => {
      // Lanes: lane 0 tall (4), lane 1 short (2), lane 2 tall (4).
      const lanes = [4, 2, 4];
      // Start on row 3 of the tall lane 0.
      const start = boardAt(0, 3);
      // Hop into the short lane 1: clamps to row 1, but remembers desiredRow 3.
      const mid = navReduce(start, { type: "move", dir: "right", lanes });
      expect(mid.board.rowIndex).toBe(1);
      expect(mid.board.desiredRow).toBe(3);
      // Hop on into the tall lane 2: restores row 3 from the remembered desiredRow.
      const end = navReduce(mid, { type: "move", dir: "right", lanes });
      expect(end.board.laneIndex).toBe(2);
      expect(end.board.rowIndex).toBe(3);
    });

    it("leaves the desired row intact across horizontal moves", () => {
      const lanes = [4, 2, 4];
      const mid = navReduce(boardAt(0, 3), { type: "move", dir: "right", lanes });
      expect(mid.board.desiredRow).toBe(3);
    });

    it("moves across the seven Issue lanes the same way while zoomed", () => {
      const right = navReduce(issuesAt(0, 0), {
        type: "move",
        dir: "right",
        lanes: [1, 0, 0, 0, 0, 0, 1],
      });
      // From lane 0 the only other non-empty lane is the last; `l` skips to it.
      expect(right.issues.laneIndex).toBe(6);
    });
  });

  describe("selectedCoord — resolving the live coordinate against a lane shape", () => {
    it("returns the stored coordinate when it rests on a card", () => {
      expect(selectedCoord(coord(1, 1), [2, 2, 2])).toEqual({ laneIndex: 1, rowIndex: 1 });
    });

    it("snaps onto the first non-empty lane when the stored lane is empty", () => {
      // Stored on the empty lane 0; resolves onto lane 1 (the first with a card).
      expect(selectedCoord(coord(0, 0), [0, 3, 2])).toEqual({ laneIndex: 1, rowIndex: 0 });
    });

    it("clamps the row to the lane's last card when the stored row overflows", () => {
      expect(selectedCoord(coord(0, 5), [3])?.rowIndex).toBe(2);
    });

    it("returns undefined when every lane is empty", () => {
      expect(selectedCoord(coord(0, 0), [0, 0, 0])).toBeUndefined();
    });
  });

  it("zooms from the board into the selected PRD's Issues, selecting the first card", () => {
    const zoomed = navReduce(boardAt(2, 0), { type: "zoom", issueCount: 4 });
    expect(zoomed.level).toBe("issues");
    expect(zoomed.board.laneIndex).toBe(2);
    expect(zoomed.issues).toEqual({ laneIndex: 0, rowIndex: 0, desiredRow: 0 });
  });

  it("backs out from Issues to the board, preserving the PRD selection", () => {
    const backed = navReduce(issuesAt(3, 2), { type: "back" });
    expect(backed.level).toBe("board");
  });

  it("treats back at the board level as a no-op", () => {
    expect(navReduce(initialNav, { type: "back" })).toBe(initialNav);
  });

  it("ignores a zoom request that arrives while already zoomed", () => {
    const zoomed = issuesAt(0, 1);
    expect(navReduce(zoomed, { type: "zoom", issueCount: 5 })).toBe(zoomed);
  });

  describe("dispatch confirmation (modal preview)", () => {
    it("is not confirming initially", () => {
      expect(initialNav.confirming).toBe(false);
    });

    it("opens the preview from the board level, entering the confirming state", () => {
      const opened = navReduce(boardAt(1, 0), { type: "open-preview" });
      expect(opened.confirming).toBe(true);
      // The underlying selection is preserved so the dispatch acts on it.
      expect(opened.board.laneIndex).toBe(1);
      expect(opened.level).toBe("board");
    });

    it("ignores open-preview at the issue (zoomed) level", () => {
      const zoomed = issuesAt(0, 1);
      expect(navReduce(zoomed, { type: "open-preview" })).toBe(zoomed);
    });

    it("suppresses movement while confirming", () => {
      const confirming: NavState = { ...initialNav, confirming: true };
      expect(navReduce(confirming, { type: "move", dir: "down", lanes: [3] })).toBe(confirming);
    });

    it("suppresses zoom while confirming", () => {
      const confirming: NavState = { ...initialNav, confirming: true };
      expect(navReduce(confirming, { type: "zoom", issueCount: 3 })).toBe(confirming);
    });

    it("closes the preview on cancel, leaving the selection untouched", () => {
      const confirming: NavState = { ...boardAt(2, 0), confirming: true };
      const cancelled = navReduce(confirming, { type: "cancel" });
      expect(cancelled.confirming).toBe(false);
      expect(cancelled.board.laneIndex).toBe(2);
      expect(cancelled.level).toBe("board");
    });

    it("closes the preview on confirm, leaving the selection untouched", () => {
      const confirming: NavState = { ...boardAt(2, 0), confirming: true };
      const confirmed = navReduce(confirming, { type: "confirm" });
      expect(confirmed.confirming).toBe(false);
      expect(confirmed.board.laneIndex).toBe(2);
    });

    it("ignores cancel/confirm when not confirming", () => {
      expect(navReduce(initialNav, { type: "cancel" })).toBe(initialNav);
      expect(navReduce(initialNav, { type: "confirm" })).toBe(initialNav);
    });
  });

  describe("review confirmation (Issue-level modal preview)", () => {
    it("opens the review preview from the Issue level, entering the confirming state", () => {
      const zoomed = issuesAt(1, 2);
      const opened = navReduce(zoomed, { type: "open-review" });
      expect(opened.confirming).toBe(true);
      // The underlying selection is preserved so the review acts on it.
      expect(opened.issues.rowIndex).toBe(2);
      expect(opened.level).toBe("issues");
    });

    it("ignores open-review at the board level (review is Issue-level only)", () => {
      expect(navReduce(initialNav, { type: "open-review" })).toBe(initialNav);
    });

    it("suppresses open-review while already confirming", () => {
      const confirming: NavState = { ...issuesAt(0, 0), confirming: true };
      expect(navReduce(confirming, { type: "open-review" })).toBe(confirming);
    });

    it("closes the review preview on cancel and on confirm, leaving selection intact", () => {
      const confirming: NavState = { ...issuesAt(1, 3), confirming: true };
      const cancelled = navReduce(confirming, { type: "cancel" });
      expect(cancelled.confirming).toBe(false);
      expect(cancelled.issues.rowIndex).toBe(3);

      const confirmed = navReduce(confirming, { type: "confirm" });
      expect(confirmed.confirming).toBe(false);
      expect(confirmed.issues.rowIndex).toBe(3);
    });
  });
});
