import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { IssueBoard } from "./IssueBoard.js";
import type { PRD } from "../model.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// The cyan border (the sole selection cue, no ▶ pointer; see Card.test.tsx) wraps
// the selected card's box across three consecutive lines — top edge, title, and
// bottom edge — each carrying the cyan SGR. Joining those lines (ANSI stripped)
// yields the selected card's title, so a test can assert *which* card is selected.
const CYAN = ESC + "[36m";
const cyanSelectedTitle = (frame: string): string =>
  frame
    .split("\n")
    .filter((line) => line.includes(CYAN))
    .map(stripAnsi)
    .join("\n");

const HEADINGS = [
  "Backlog",
  "Ready",
  "In Progress",
  "Ready for Review",
  "In Review",
  "Human Review",
  "Done",
];

/** The column a piece of text lands in, by horizontal offset (see Board.test). */
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

const prd: PRD = {
  id: "auth",
  title: "Authentication",
  lane: "in-progress",
  issues: [
    { id: "010-login", title: "Login", lane: "in-progress", liveness: "live" },
    {
      id: "020-oauth",
      title: "OAuth",
      lane: "ready",
      readyFor: "agent",
      suppressed: true,
    },
    { id: "030-review", title: "Review", lane: "ready", readyFor: "human" },
    { id: "005-mystery", title: "Mystery", lane: "backlog", malformedStatus: true },
    {
      id: "040-escalated",
      title: "Escalated",
      lane: "human-review",
      humanReviewReason: "deviation",
    },
    {
      id: "050-reviewing",
      title: "Reviewing",
      lane: "in-review",
      liveness: "unknown",
    },
  ],
};

describe("IssueBoard", () => {
  it("renders the PRD's Issues as cards in their lanes", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(columnOf(frame, "Login")).toBe("In Progress");
    expect(columnOf(frame, "OAuth")).toBe("Ready");
    expect(columnOf(frame, "Mystery")).toBe("Backlog");
  });

  it("folds a malformed-status Issue into Backlog with a loud warning marker", () => {
    // The Unsorted column is gone (no such heading renders); a missing/unknown
    // status lands in Backlog carrying the `⚠ bad status` marker, so the data
    // error stays triageable rather than parked as ordinary backlog.
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(stripAnsi(frame)).not.toContain("Unsorted");
    expect(columnOf(frame, "Mystery")).toBe("Backlog");
    expect(columnOf(frame, "bad status")).toBe("Backlog");
  });

  it("shows a human/agent badge on ready Issues", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(frame).toContain("🤖");
    expect(frame).toContain("🧑");
  });

  it("surfaces the escalation reason on a human-review Issue card", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(columnOf(frame, "Escalated")).toBe("Human Review");
    expect(stripAnsi(frame)).toContain("deviation");
  });

  it("surfaces the live marker on an in-progress Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(columnOf(frame, "Login")).toBe("In Progress");
    expect(columnOf(frame, "live")).toBe("In Progress");
  });

  it("surfaces the unknown marker on an in-review Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(columnOf(frame, "Reviewing")).toBe("In Review");
    expect(columnOf(frame, "unknown")).toBe("In Review");
  });

  it("surfaces the suppressed marker on a launch-failed ready Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selected={{ laneIndex: 0, rowIndex: 0 }} />).lastFrame() ?? "";

    expect(columnOf(frame, "OAuth")).toBe("Ready");
    expect(columnOf(frame, "suppressed")).toBe("Ready");
  });

  it("marks the Issue at the selected (lane, row) coordinate by cyan border alone, with no pointer arrow", () => {
    // OAuth is the first card in the Ready lane (laneIndex 1 of ISSUE_LANES).
    // Selection is the cyan border alone — no prepended ▶ pointer eating the
    // title line (the cyan-border-only treatment; see Card.test.tsx). The badge
    // and title still read, just without the arrow tax in front of them.
    const frame =
      render(<IssueBoard prd={prd} selected={{ laneIndex: 1, rowIndex: 0 }} />)
        .lastFrame() ?? "";
    const flat = stripAnsi(frame);

    // The selected Issue's badge + title still read, unprefixed by any pointer…
    expect(flat).toMatch(/🤖 OAuth/);
    // …and the ▶ pointer appears nowhere in the frame.
    expect(flat).not.toContain("▶");
    // The cyan border is the sole selection cue — present in the rendered frame.
    expect(frame).toContain(ESC + "[36m");
  });

  it("selects the second card down within a lane (row index, not flat order)", () => {
    // Review is the second card in the Ready lane (row 1), after OAuth (row 0).
    // Selecting row 1 must mark Review's card, not OAuth's — proven by the cyan
    // border (the sole selection cue) landing on Review's box and not OAuth's.
    const frame =
      render(<IssueBoard prd={prd} selected={{ laneIndex: 1, rowIndex: 1 }} />)
        .lastFrame() ?? "";

    // The cyan-bordered (selected) card's title is Review's, not OAuth's.
    expect(cyanSelectedTitle(frame)).toMatch(/🧑 Review/);
    expect(cyanSelectedTitle(frame)).not.toMatch(/OAuth/);
  });

  it("scrolls a tall lane to keep the selected Issue in view", () => {
    // A backlog lane far taller than the available height: with `laneHeight`
    // wired, selecting a deep card scrolls it into view and windows out the rest
    // (ADR 0015), so no Issue is unreachable when zoomed on a short terminal.
    const tall: PRD = {
      id: "big",
      title: "Big PRD",
      lane: "backlog",
      issues: Array.from({ length: 20 }, (_, i) => ({
        id: `i${i}`,
        title: `Task-${i}`,
        lane: "backlog" as const,
      })),
    };

    const frame =
      render(
        <IssueBoard
          prd={tall}
          selected={{ laneIndex: 0, rowIndex: 18 }}
          laneHeight={5}
        />,
      ).lastFrame() ?? "";
    // The deep selected Issue (Task-18) scrolled into view carrying the cyan
    // border, and the top of the lane (Task-0) windowed out.
    expect(cyanSelectedTitle(frame)).toMatch(/Task-18/);
    expect(stripAnsi(frame)).not.toContain("Task-0");
  });
});
