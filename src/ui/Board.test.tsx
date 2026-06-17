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

// The SGR code Ink emits for a cyan foreground — the selected card's border,
// which is the sole selection cue (no ▶ pointer; see Card.test.tsx). Counting
// its runs counts selected cards (Ink emits it once per bordered line).
const CYAN = ESC + "[36m";
const cyanRuns = (raw: string): number =>
  (raw.match(new RegExp(ESC + "\\[36m", "g")) ?? []).length;

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

  it("highlights the card at the selected (lane, row) coordinate, and no other", () => {
    // Two cards stacked in the in-progress lane; row 1 (the second) is selected.
    const board: Board = {
      prds: [
        prd({ id: "todo", title: "TodoCard", lane: "backlog" }),
        prd({ id: "first", title: "FirstInProgress", lane: "in-progress" }),
        prd({ id: "second", title: "SecondInProgress", lane: "in-progress" }),
      ],
    };

    const frame =
      render(<BoardView board={board} selected={{ laneIndex: 1, rowIndex: 1 }} />)
        .lastFrame() ?? "";

    // The cyan-border selection cue marks the second in-progress card and no
    // other: the rendered cyan runs equal exactly one selected card's worth (a
    // board with a single card selected).
    const oneSelected =
      render(
        <BoardView
          board={{ prds: [prd({ id: "x", title: "Only", lane: "backlog" })] }}
          selected={{ laneIndex: 0, rowIndex: 0 }}
        />,
      ).lastFrame() ?? "";
    expect(stripAnsi(frame)).toContain("SecondInProgress");
    expect(cyanRuns(frame)).toBe(cyanRuns(oneSelected));
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

  it("renders only the visible window of an overflowing lane", () => {
    // A backlog lane far taller than the available height: with `laneHeight`
    // wired the board renders only the lane's window, not every card (ADR 0015).
    const prds = Array.from({ length: 20 }, (_, i) =>
      prd({ id: `b${i}`, title: `Backlog-${i}`, lane: "backlog" }),
    );

    const frame =
      render(
        <BoardView
          board={{ prds }}
          selected={{ laneIndex: 0, rowIndex: 0 }}
          laneHeight={5}
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("Backlog-0");
    expect(frame).not.toContain("Backlog-19");
  });

  it("scrolls a tall lane to keep the selected card in view", () => {
    // Selecting a card past the window's bottom scrolls it into view, so no card
    // is unreachable on a short terminal.
    const prds = Array.from({ length: 20 }, (_, i) =>
      prd({ id: `b${i}`, title: `Backlog-${i}`, lane: "backlog" }),
    );

    const frame =
      render(
        <BoardView
          board={{ prds }}
          selected={{ laneIndex: 0, rowIndex: 18 }}
          laneHeight={5}
        />,
      ).lastFrame() ?? "";
    // The selected card (Backlog-18) scrolled into the window carrying the
    // cyan-border cue, and the top of the lane scrolled away.
    expect(stripAnsi(frame)).toContain("Backlog-18");
    expect(frame).toContain(CYAN);
    expect(stripAnsi(frame)).not.toContain("Backlog-0");
  });

  it("renders every card of a lane that fits the available height", () => {
    const prds = Array.from({ length: 3 }, (_, i) =>
      prd({ id: `b${i}`, title: `Backlog-${i}`, lane: "backlog" }),
    );

    const frame =
      render(
        <BoardView
          board={{ prds }}
          selected={{ laneIndex: 0, rowIndex: 0 }}
          laneHeight={10}
        />,
      ).lastFrame() ?? "";

    for (let i = 0; i < 3; i++) {
      expect(frame).toContain(`Backlog-${i}`);
    }
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
