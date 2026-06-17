import { describe, it, expect } from "vitest";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { DEFAULT_REVIEW_CONFIG, type ReviewConfig } from "./reviewConfig.js";
import type { DispatchIssue } from "../dispatch/reader.js";

const issue: DispatchIssue = {
  id: "001-password-hashing.md",
  title: "Password hashing",
  status: "in-review",
  blockedBy: [],
  repo: "/Users/daniel/code/backend",
  worktree: "/Users/daniel/.worktrees/worktree-blue-cat-fox",
  branch: "worktree-blue-cat-fox",
  deviation: undefined,
  body: "Hash passwords with argon2id before persisting them.",
  path: "/root/auth-system/001-password-hashing.md",
};

const prdTitle = "Authentication System";
const prdBody = "## Problem\nUsers cannot sign in.\n\n## Solution\nBuild auth.";

const context = {
  prdTitle,
  prdBody,
  featureBranch: "auth-system",
  review: DEFAULT_REVIEW_CONFIG,
};

function build(overrides: Partial<DispatchIssue> = {}): string {
  return buildReviewerPrompt({ issue: { ...issue, ...overrides }, ...context });
}

/** Build with the given review config, defaults otherwise. */
function buildWithReview(review: ReviewConfig): string {
  return buildReviewerPrompt({ issue, ...context, review });
}

describe("buildReviewerPrompt", () => {
  it("embeds the full Issue body verbatim", () => {
    expect(build()).toContain(issue.body);
  });

  it("embeds the full parent PRD body verbatim", () => {
    expect(build()).toContain(prdBody);
  });

  it("includes the Issue and PRD titles for orientation", () => {
    const prompt = build();
    expect(prompt).toContain(issue.title);
    expect(prompt).toContain(prdTitle);
  });

  it("instructs checking out the recorded worktree by its exact path", () => {
    const prompt = build();
    expect(prompt.toLowerCase()).toContain("worktree");
    expect(prompt).toContain(issue.worktree!);
  });

  it("runs a single /code-review pass at the default medium effort", () => {
    const prompt = build();
    expect(prompt).toContain("/code-review");
    expect(prompt.toLowerCase()).toContain("medium");
  });

  it("reviews the inherited worktree FIRST, before fixing anything", () => {
    // Independence is a pass-boundary property: the fresh pass agent reviews the
    // code it inherited before it fixes anything, so it never reviews its own
    // fixes. The prompt must put the review instruction before the fix.
    const prompt = build().toLowerCase();
    const reviewIdx = prompt.indexOf("/code-review");
    const fixIdx = prompt.indexOf("fix");
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeLessThan(fixIdx);
  });

  it("drives a single pass: no internal /code-review loop", () => {
    // The Reactor (not the prompt) drives each pass as its own spawn, so the
    // prompt must not tell the agent to loop /code-review or repeat the review.
    const prompt = build().toLowerCase();
    expect(prompt).not.toMatch(/\bloop\b|\brepeat\b|run it again|up to/);
  });

  it("does not name the cap as a loop bound", () => {
    // The cap / non-convergence escalation moved into the Reactor; a non-default
    // cap must not leak into the prompt as a pass bound at all.
    const prompt = buildWithReview({ cap: 5, effort: "medium" });
    expect(prompt).not.toMatch(/\bcap\b|\bpasses\b|\bconverge/i);
    expect(prompt).not.toContain("5");
  });

  it("does not escalate non-convergence itself (that is the Reactor's job)", () => {
    // The prompt owns deviation and conflict escalations only; non-convergence
    // is enforced by the Reactor reading the sidecar count.
    const prompt = build().toLowerCase();
    expect(prompt).not.toContain("non-convergence");
    expect(prompt).not.toMatch(/converge/);
  });

  it("uses the configured effort, not a hardcoded medium", () => {
    const prompt = buildWithReview({ cap: 3, effort: "high" });
    expect(prompt.toLowerCase()).toContain("high");
    // The pass instruction names HIGH effort, not the old MEDIUM literal.
    expect(prompt).toContain("HIGH effort");
    expect(prompt).not.toContain("MEDIUM effort");
  });

  it("instructs fixing findings", () => {
    expect(build().toLowerCase()).toContain("fix");
  });

  it("names the PRD feature branch as the merge target", () => {
    expect(build()).toContain(context.featureBranch);
  });

  it("names the recorded branch to merge", () => {
    expect(build()).toContain(issue.branch!);
  });

  it("merges only into the feature branch, never main", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toMatch(/never .*main|not .*main|never merge .*main/);
  });

  it("names the repo and runs the merge there with git -C, not from the worktree", () => {
    const prompt = build();
    expect(prompt).toContain(issue.repo!);
    // The merge must be anchored to the repo (git -C <repo>), not run from
    // inside the worktree, so its direction is unambiguous.
    expect(prompt).toContain(`git -C ${issue.repo} checkout ${context.featureBranch}`);
    expect(prompt).toContain(`git -C ${issue.repo} merge --no-ff ${issue.branch}`);
    expect(prompt).toContain(`git -C ${issue.repo} merge --abort`);
  });

  it("routes a zero-findings pass with no deviation to merge then done", () => {
    const prompt = build();
    expect(prompt).toContain("done");
    // The clean path merges then sets done.
    expect(prompt.toLowerCase()).toContain("merge");
  });

  it("defines the clean exit as a pass that reports zero findings", () => {
    expect(build().toLowerCase()).toMatch(/zero findings|no findings/);
  });

  it("routes a pass WITH findings to fix then set ready-for-review", () => {
    // The between-passes return: a pass that found and fixed issues sets the
    // Issue back to ready-for-review so the Reactor spawns the next pass.
    const prompt = build();
    expect(prompt).toContain("ready-for-review");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("fix");
    expect(lower).toContain("ready-for-review");
  });

  it("routes a merge conflict to human-review with reason conflict", () => {
    const prompt = build();
    expect(prompt.toLowerCase()).toContain("human-review");
    expect(prompt).toContain("conflict");
  });

  it("writes the final status into the Issue file by its path", () => {
    expect(build()).toContain(issue.path);
  });

  it("tells the reviewer no deviation was recorded so the clean path is open", () => {
    const prompt = build({ deviation: undefined }).toLowerCase();
    expect(prompt).toContain("no deviation");
  });

  it("tells the reviewer a deviation was recorded and routes it to human-review", () => {
    const prompt = build({ deviation: "Used a queue instead of inline send." });
    expect(prompt).toContain("Used a queue instead of inline send.");
    expect(prompt.toLowerCase()).toContain("human-review");
  });

  it("instructs recording the human-review reason alongside the status", () => {
    const prompt = build();
    expect(prompt).toContain("human_review_reason");
  });

  it("names the deviation and conflict escalation reasons it owns", () => {
    const prompt = build();
    expect(prompt).toContain("deviation");
    expect(prompt).toContain("conflict");
  });

  it("instructs writing a free-text human_review_note alongside the status and reason", () => {
    const prompt = build();
    expect(prompt).toContain("human_review_note");
  });

  it("instructs writing the note for both escalation reasons it owns", () => {
    // The note must be written for conflict as well as deviation — conflict
    // otherwise carries no prose at all.
    const prompt = build().toLowerCase();
    expect(prompt).toMatch(/both|each|either|regardless of/);
    expect(prompt).toContain("conflict");
    expect(prompt).toContain("deviation");
  });

  it("on a deviation, instructs folding the implementor's deviation note into the single human_review_note", () => {
    const prompt = build({ deviation: "Used a queue instead of inline send." });
    // The implementor's recorded deviation is handed to the reviewer, and the
    // reviewer is told to fold it into the one user-facing note.
    expect(prompt).toContain("Used a queue instead of inline send.");
    expect(prompt.toLowerCase()).toContain("fold");
    expect(prompt).toContain("human_review_note");
  });

  it("does NOT instruct the reviewer to set in-review (the trigger already did)", () => {
    // The review trigger flips ready-for-review → in-review before spawning, so
    // the reviewer inherits in-review and must never set it. Assert over the
    // static template only, since caller bodies may legitimately mention it.
    const prompt = buildReviewerPrompt({
      issue: { ...issue, body: "", title: "", branch: "b", worktree: "/w" },
      prdTitle: "",
      prdBody: "",
      featureBranch: "fb",
      review: DEFAULT_REVIEW_CONFIG,
    });
    expect(prompt).not.toContain("in-review");
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });
});
