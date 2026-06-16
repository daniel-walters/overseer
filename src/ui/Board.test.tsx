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

  it("renders a done PRD's Linked PR marker on its board card", () => {
    // The overlay reaches the board card end-to-end: a `done` PRD carrying a
    // merged Linked PR shows the marker under the Done column (ADR 0013).
    const board: Board = {
      prds: [
        prd({
          id: "shipped",
          title: "Landed",
          lane: "done",
          linkedPr: { state: "merged", url: "https://gh/pr/7" },
        }),
      ],
    };

    const frame = render(<BoardView board={board} />).lastFrame() ?? "";

    expect(frame).toContain("PR merged");
    expect(columnOf(frame, "PR merged")).toBe("Done");
  });

  it("renders no PR marker on a done PRD without a linked PR", () => {
    const board: Board = {
      prds: [prd({ id: "shipped", title: "Unopened", lane: "done" })],
    };

    const frame = render(<BoardView board={board} />).lastFrame() ?? "";

    expect(frame).toContain("Unopened");
    expect(frame).not.toMatch(/PR open|PR merged/);
  });

  it("widens columns on a wide terminal so a long title shows in full", () => {
    // A title longer than the 24 floor's title budget but well within a wide
    // terminal's 3-column share: it must survive untruncated, proving the column
    // took the distributed width rather than the old hardcoded 24.
    const longTitle = "Share one failed-set across all spawn edges";
    const board: Board = {
      prds: [prd({ id: "x", title: longTitle, lane: "backlog" })],
    };

    const frame = render(<BoardView board={board} />, 240).lastFrame() ?? "";

    expect(frame).toContain(longTitle);
  });

  it("clamps columns to the floor on a narrow terminal — never below 24", () => {
    // The same long title on a narrow terminal truncates (the column holds at the
    // 24 floor), but the truncated head still identifies the card. It must not
    // render in full — that would mean the column shrank/grew wrongly.
    const longTitle = "Share one failed-set across all spawn edges";
    const board: Board = {
      prds: [prd({ id: "x", title: longTitle, lane: "backlog" })],
    };

    // 60 cols / 3 = 20, below the floor, so each column holds at 24.
    const frame = render(<BoardView board={board} />, 60).lastFrame() ?? "";

    expect(frame).not.toContain(longTitle);
    expect(frame).toContain("Share one");
  });
});
