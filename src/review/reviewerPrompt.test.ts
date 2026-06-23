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
  reviewVerdict: undefined,
  slice: undefined,
  body: "Hash passwords with argon2id before persisting them.",
  path: "/root/auth-system/001-password-hashing.md",
};

const prdTitle = "Authentication System";
const prdBody = "## Problem\nUsers cannot sign in.\n\n## Solution\nBuild auth.";

const context = {
  prdTitle,
  prdBody,
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

  it("names the repo the review runs in", () => {
    expect(build()).toContain(issue.repo!);
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
    // The cap / non-convergence escalation lives in the Reactor; a non-default
    // cap must not leak into the prompt as a pass bound at all.
    const prompt = buildWithReview({ cap: 5, effort: "medium" });
    expect(prompt).not.toMatch(/\bcap\b|\bpasses\b|\bconverge/i);
    expect(prompt).not.toContain("5");
  });

  it("uses the configured effort, not a hardcoded medium", () => {
    const prompt = buildWithReview({ cap: 3, effort: "high" });
    expect(prompt.toLowerCase()).toContain("high");
    expect(prompt).toContain("HIGH effort");
    expect(prompt).not.toContain("MEDIUM effort");
  });

  // The two — and only two — exits the pass agent now owns (ADR 0019).

  it("CLEAN exit: a zero-findings pass writes review_verdict: clean", () => {
    const prompt = build();
    expect(prompt).toContain("review_verdict: clean");
  });

  it("defines the clean exit as a pass that reports zero findings", () => {
    expect(build().toLowerCase()).toMatch(/zero findings|no findings/);
  });

  it("CLEAN exit: never merges and never writes a terminal status itself", () => {
    // Overseer owns the merge and the terminal `done` write now (ADR 0019); the
    // clean exit is just the verdict bit. The prompt may *explain* that Overseer
    // merges, but must never hand the agent a merge command or a `done` write.
    const prompt = build().toLowerCase();
    expect(prompt).not.toContain("merge --no-ff");
    expect(prompt).not.toMatch(/git -c \S+ .*merge/);
    expect(prompt).not.toContain("status: done");
    // And it tells the agent in so many words that it does not merge.
    expect(prompt).toContain("do not merge");
  });

  it("CLEAN exit: does not change the Issue status (Overseer owns the terminal write)", () => {
    // The agent leaves the status untouched on the clean exit — it only adds the
    // verdict. Asserted over the static template (caller bodies may mention it).
    const prompt = buildReviewerPrompt({
      issue: { ...issue, body: "", title: "", worktree: "/w" },
      prdTitle: "",
      prdBody: "",
      review: DEFAULT_REVIEW_CONFIG,
    });
    expect(prompt).not.toContain("status: done");
    expect(prompt).not.toContain("status: in-review");
  });

  it("FINDINGS exit: fix, commit, then set ready-for-review", () => {
    const prompt = build();
    expect(prompt).toContain("ready-for-review");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("fix");
    expect(lower).toContain("commit");
  });

  it("does not reason about deviations, branches, conflicts, or human-review", () => {
    // The agent's brief shrank to two exits; it no longer reasons about merges,
    // the branch to merge, recorded deviations, conflicts, or a human-review exit.
    const prompt = build({ deviation: "Used a queue instead of inline send." });
    expect(prompt.toLowerCase()).not.toMatch(/deviation|human-review|conflict/);
    // Even with a deviation recorded on the Issue, the prompt never surfaces it.
    expect(prompt).not.toContain("Used a queue instead of inline send.");
  });

  it("writes the verdict/status into the Issue file by its path", () => {
    expect(build()).toContain(issue.path);
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });
});
