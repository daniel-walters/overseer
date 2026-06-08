import { describe, it, expect } from "vitest";
import { buildImplementorPrompt } from "./implementorPrompt.js";
import type { IssueRecord, PrdRecord } from "./records.js";

const issue: IssueRecord = {
  id: "001-password-hashing.md",
  title: "Password hashing",
  status: "in-progress",
  blockedBy: [],
  repo: "/Users/daniel/code/backend",
  body: "Hash passwords with argon2id before persisting them.\n\n## AC\n- [ ] argon2id used",
  path: "/root/auth-system/001-password-hashing.md",
};

const prd: PrdRecord = {
  id: "auth-system",
  title: "Authentication System",
  body: "## Problem\nUsers cannot sign in.\n\n## Solution\nBuild auth.",
};

const context = { repo: "/Users/daniel/code/backend", featureBranch: "auth-system" };

function build(): string {
  return buildImplementorPrompt({ issue, prd, ...context });
}

describe("buildImplementorPrompt", () => {
  it("embeds the full Issue body verbatim", () => {
    expect(build()).toContain(issue.body);
  });

  it("embeds the full parent PRD body verbatim", () => {
    expect(build()).toContain(prd.body);
  });

  it("names the target repo", () => {
    expect(build()).toContain(context.repo);
  });

  it("names the per-repo feature branch", () => {
    expect(build()).toContain(context.featureBranch);
  });

  it("instructs the agent to work in a worktree off the feature branch", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("worktree");
    expect(prompt).toContain("feature branch");
  });

  it("instructs the agent to commit to the worktree with no PR", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("commit");
    expect(prompt).toMatch(/no pull request|no pr|do not open a (pull request|pr)/);
  });

  it("instructs the agent to flip the Issue to in-review on completion", () => {
    const prompt = build();
    expect(prompt).toContain("in-review");
    // and to write that status into the Issue file in the Overseer root.
    expect(prompt).toContain(issue.path);
  });

  it("does NOT instruct the agent to set in-progress (the dispatcher already did)", () => {
    expect(build()).not.toContain("in-progress");
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });

  it("includes the Issue and PRD titles for orientation", () => {
    const prompt = build();
    expect(prompt).toContain(issue.title);
    expect(prompt).toContain(prd.title);
  });
});
