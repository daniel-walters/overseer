import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { IssueBoard } from "./IssueBoard.js";
import type { PRD } from "../model.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const HEADINGS = [
  "Unsorted",
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
    { id: "005-mystery", title: "Mystery", lane: "unsorted" },
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
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(columnOf(frame, "Login")).toBe("In Progress");
    expect(columnOf(frame, "OAuth")).toBe("Ready");
    expect(columnOf(frame, "Mystery")).toBe("Unsorted");
  });

  it("shows a human/agent badge on ready Issues", () => {
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(frame).toContain("🤖");
    expect(frame).toContain("🧑");
  });

  it("surfaces the escalation reason on a human-review Issue card", () => {
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(columnOf(frame, "Escalated")).toBe("Human Review");
    expect(stripAnsi(frame)).toContain("deviation");
  });

  it("surfaces the live marker on an in-progress Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(columnOf(frame, "Login")).toBe("In Progress");
    expect(columnOf(frame, "live")).toBe("In Progress");
  });

  it("surfaces the unknown marker on an in-review Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(columnOf(frame, "Reviewing")).toBe("In Review");
    expect(columnOf(frame, "unknown")).toBe("In Review");
  });

  it("surfaces the suppressed marker on a launch-failed ready Issue's card", () => {
    const frame = render(<IssueBoard prd={prd} selectedIndex={0} />).lastFrame() ?? "";

    expect(columnOf(frame, "OAuth")).toBe("Ready");
    expect(columnOf(frame, "suppressed")).toBe("Ready");
  });

  it("marks the selected Issue with a pointer and no other", () => {
    const frame =
      render(<IssueBoard prd={prd} selectedIndex={1} />).lastFrame() ?? "";
    const flat = stripAnsi(frame);

    // The pointer immediately precedes the selected Issue's badge/title…
    expect(flat).toMatch(/▶ 🤖 OAuth/);
    // …and appears exactly once across the whole frame.
    expect(flat.match(/▶/g)?.length).toBe(1);
  });
});
