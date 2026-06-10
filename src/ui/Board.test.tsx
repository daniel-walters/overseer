import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { BoardView } from "./Board.js";
import type { Board, PRD } from "../model.js";

const emptyBoard: Board = { prds: [] };

/** Build a PRD for rendering tests; Issues are irrelevant at the board level. */
function prd(p: Omit<PRD, "issues">): PRD {
  return { ...p, issues: [] };
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const HEADINGS = ["Backlog", "In Progress", "Done"];

/**
 * The column a piece of text lands in, by horizontal offset. Columns are laid
 * out left to right at fixed widths, so a card sits in the same column as the
 * heading whose left edge is nearest at or before it. ANSI styling is stripped
 * first so offsets are measured in visible characters.
 */
function columnOf(rawFrame: string, needle: string): string {
  const lines = stripAnsi(rawFrame).split("\n");

  const needleLine = lines.find((l) => l.includes(needle));
  if (!needleLine) throw new Error(`"${needle}" not found in frame`);
  const needleCol = needleLine.indexOf(needle);

  const headingLine = lines.find((l) => HEADINGS.some((h) => l.includes(h)));
  if (!headingLine) throw new Error("no heading line found in frame");

  let best = "";
  let bestCol = -1;
  for (const h of HEADINGS) {
    const col = headingLine.indexOf(h);
    if (col !== -1 && col <= needleCol && col > bestCol) {
      bestCol = col;
      best = h;
    }
  }
  return best;
}

describe("BoardView", () => {
  it("collapses to the three board columns — backlog / in-progress / done", () => {
    const { lastFrame } = render(<BoardView board={emptyBoard} />);
    const frame = lastFrame() ?? "";

    for (const heading of HEADINGS) {
      expect(frame).toContain(heading);
    }
    // No Issue-level columns leak into the board level (ADR 0003).
    for (const absent of ["Unsorted", "Ready", "Review"]) {
      expect(frame).not.toContain(absent);
    }
  });

  it("places each PRD card under its derived lane's column", () => {
    const board: Board = {
      prds: [
        prd({ id: "todo", title: "TodoCard", lane: "backlog" }),
        prd({ id: "auth", title: "AuthCard", lane: "in-progress" }),
        prd({ id: "shipped", title: "DoneCard", lane: "done" }),
      ],
    };

    const frame = render(<BoardView board={board} />).lastFrame() ?? "";

    expect(columnOf(frame, "TodoCard")).toBe("Backlog");
    expect(columnOf(frame, "AuthCard")).toBe("In Progress");
    expect(columnOf(frame, "DoneCard")).toBe("Done");
  });
});
