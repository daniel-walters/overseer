import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ReviewPreview } from "./ReviewPreview.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";
import type { DispatchIssue } from "../dispatch/reader.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: "002-payment.md",
    title: "Payment intent",
    path: "/root/checkout/002-payment.md",
    status: "ready-for-review",
    blockedBy: [],
    repo: "/repos/backend",
    worktree: "/wt/blue-cat-fox",
    branch: "blue-cat-fox",
    deviation: undefined,
    body: "",
    ...overrides,
  };
}

function reviewable(overrides: Partial<DispatchIssue> = {}): ReviewPreviewData {
  return { issue: issue(overrides), eligibility: { reviewable: true } };
}

function skipped(reason: string, overrides: Partial<DispatchIssue> = {}): ReviewPreviewData {
  return { issue: issue(overrides), eligibility: { reviewable: false, reason } };
}

describe("ReviewPreview", () => {
  it("names the Issue under review", () => {
    const { lastFrame } = render(<ReviewPreview preview={reviewable()} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Payment intent");
  });

  it("shows the recorded worktree and branch the reviewer will use", () => {
    const { lastFrame } = render(<ReviewPreview preview={reviewable()} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/wt/blue-cat-fox");
    expect(frame).toContain("blue-cat-fox");
  });

  it("shows the confirm/cancel keys when the Issue is reviewable", () => {
    const { lastFrame } = render(<ReviewPreview preview={reviewable()} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/enter|y/);
    expect(frame).toMatch(/esc/);
  });

  it("flags that a recorded deviation forces a human review", () => {
    const { lastFrame } = render(
      <ReviewPreview preview={reviewable({ deviation: "took a shortcut" })} />,
    );
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toContain("deviation");
    expect(frame).toContain("human");
  });

  it("shows the skip reason and no confirm when the Issue is not reviewable", () => {
    const { lastFrame } = render(
      <ReviewPreview preview={skipped('status is "in-progress", not ready-for-review')} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("in-progress");
    // No "spawn/confirm" affordance for an ineligible Issue — only a dismiss.
    expect(frame.toLowerCase()).toMatch(/esc|dismiss|back/);
    expect(frame.toLowerCase()).not.toMatch(/y to review|enter .* review/);
  });
});
