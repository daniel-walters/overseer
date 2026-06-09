import { describe, it, expect } from "vitest";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
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

const context = { prdTitle, prdBody, featureBranch: "auth-system" };

function build(overrides: Partial<DispatchIssue> = {}): string {
  return buildReviewerPrompt({ issue: { ...issue, ...overrides }, ...context });
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

  it("encodes the /code-review loop at medium effort with a cap of 3 passes", () => {
    const prompt = build();
    expect(prompt).toContain("/code-review");
    expect(prompt.toLowerCase()).toContain("medium");
    expect(prompt).toContain("3");
  });

  it("defines convergence as a pass that reports zero findings", () => {
    expect(build().toLowerCase()).toMatch(/zero findings|no findings/);
  });

  it("instructs fixing findings as it goes", () => {
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

  it("routes a clean converged pass with no deviation to merge then done", () => {
    const prompt = build();
    expect(prompt).toContain("done");
    // The clean path merges then sets done.
    expect(prompt.toLowerCase()).toContain("merge");
  });

  it("routes non-convergence and merge conflict to human-review", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("human-review");
    expect(prompt).toMatch(/conflict/);
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

  it("does NOT instruct the reviewer to set in-review (the trigger already did)", () => {
    // The review trigger flips ready-for-review → in-review before spawning, so
    // the reviewer inherits in-review and must never set it. Assert over the
    // static template only, since caller bodies may legitimately mention it.
    const prompt = buildReviewerPrompt({
      issue: { ...issue, body: "", title: "", branch: "b", worktree: "/w" },
      prdTitle: "",
      prdBody: "",
      featureBranch: "fb",
    });
    expect(prompt).not.toContain("in-review");
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });
});
