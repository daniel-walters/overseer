import { describe, it, expect } from "vitest";
import { classifyReviewability } from "./eligibility.js";
import type { DispatchIssue } from "../dispatch/reader.js";

/** A ready-for-review Issue carrying the implementor's handoff fields. */
function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    title: overrides.title ?? (overrides.id ?? "001-a.md"),
    path: overrides.path ?? `/root/prd/${overrides.id ?? "001-a.md"}`,
    status: "status" in overrides ? overrides.status : "ready-for-review",
    blockedBy: overrides.blockedBy ?? [],
    repo: "repo" in overrides ? overrides.repo : "/repos/backend",
    worktree: "worktree" in overrides ? overrides.worktree : "/wt/blue-cat-fox",
    branch: "branch" in overrides ? overrides.branch : "blue-cat-fox",
    deviation: overrides.deviation,
    body: overrides.body ?? "",
  };
}

describe("classifyReviewability", () => {
  it("is reviewable when ready-for-review with a worktree and branch recorded", () => {
    expect(classifyReviewability(issue())).toEqual({ reviewable: true });
  });

  it("is reviewable even when the implementor recorded a deviation", () => {
    // A deviation forces a human review *outcome*, but the Issue is still
    // eligible to spawn the reviewer — the AI loop runs first regardless.
    expect(
      classifyReviewability(issue({ deviation: "took a shortcut" })),
    ).toEqual({ reviewable: true });
  });

  it("skips an Issue that is not ready-for-review, naming its status", () => {
    const result = classifyReviewability(issue({ status: "in-progress" }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/in-progress/);
  });

  it("skips an Issue with no status at all", () => {
    const result = classifyReviewability(issue({ status: undefined }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toBeTruthy();
  });

  it("skips an already in-review Issue (a reviewer already has it)", () => {
    const result = classifyReviewability(issue({ status: "in-review" }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/in-review/);
  });

  it("skips a ready-for-review Issue with no worktree recorded", () => {
    const result = classifyReviewability(issue({ worktree: undefined }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/worktree/);
  });

  it("skips a ready-for-review Issue with a blank worktree", () => {
    const result = classifyReviewability(issue({ worktree: "   " }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/worktree/);
  });

  it("skips a ready-for-review Issue with no branch recorded", () => {
    const result = classifyReviewability(issue({ branch: undefined }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/branch/);
  });

  it("skips a ready-for-review Issue with a blank branch", () => {
    const result = classifyReviewability(issue({ branch: "  " }));
    expect(result.reviewable).toBe(false);
    if (!result.reviewable) expect(result.reason).toMatch(/branch/);
  });
});
