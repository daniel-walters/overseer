import { describe, it, expect } from "vitest";
import { buildImplementorPrompt } from "./implementorPrompt.js";
import type { DispatchIssue } from "./reader.js";

const issue: DispatchIssue = {
  id: "001-password-hashing.md",
  title: "Password hashing",
  status: "in-progress",
  blockedBy: [],
  repo: "/Users/daniel/code/backend",
  worktree: undefined,
  branch: undefined,
  deviation: undefined,
  body: "Hash passwords with argon2id before persisting them.\n\n## AC\n- [ ] argon2id used",
  path: "/root/auth-system/001-password-hashing.md",
};

const prdTitle = "Authentication System";
const prdBody = "## Problem\nUsers cannot sign in.\n\n## Solution\nBuild auth.";

const context = {
  prdTitle,
  prdBody,
  repo: "/Users/daniel/code/backend",
  featureBranch: "auth-system",
};

function build(): string {
  return buildImplementorPrompt({ issue, ...context });
}

describe("buildImplementorPrompt", () => {
  it("embeds the full Issue body verbatim", () => {
    expect(build()).toContain(issue.body);
  });

  it("embeds the full parent PRD body verbatim", () => {
    expect(build()).toContain(prdBody);
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

  it("instructs the agent to drive implementation with the overseer-tdd skill", () => {
    const prompt = build();
    // A static instruction must name the bundled `overseer-tdd` skill so dispatched
    // work is test-driven (red-green-refactor) rather than test-optional.
    expect(prompt).toContain("overseer-tdd");
    expect(prompt.toLowerCase()).toMatch(/red-green-refactor|test-driven|test-first/);
  });

  it("names the overseer-tdd skill in the static template, not just caller-supplied bodies", () => {
    // Assert over the static template only (empty Issue/PRD), so the overseer-tdd
    // mandate is a property of the prompt itself, not something a caller's body
    // happened to mention. This preserves the deterministic/auditable template property.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt).toContain("overseer-tdd");
  });

  it("instructs the agent to commit to the worktree with no PR", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("commit");
    expect(prompt).toMatch(/no pull request|no pr|do not open a (pull request|pr)/);
  });

  it("instructs the agent to park the Issue at ready-for-review on completion", () => {
    const prompt = build();
    expect(prompt).toContain("ready-for-review");
    // and to write that status into the Issue file in the Overseer root.
    expect(prompt).toContain(issue.path);
  });

  it("does NOT instruct the agent to write in-review (that's the reviewer's flip)", () => {
    // The implementor now stops one step earlier: it parks at ready-for-review,
    // and the review trigger flips ready-for-review → in-review. Assert over the
    // static template only, since caller-supplied bodies may mention in-review.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt).not.toContain("in-review");
  });

  it("instructs recording the worktree path and branch in the Issue frontmatter", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("worktree");
    expect(prompt).toContain("branch");
  });

  it("instructs recording a deviation field only if it strayed from the plan", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("deviation");
    expect(prompt).toMatch(/only if|iff|when you stray|if you stray/);
  });

  it("does NOT instruct the agent to set in-progress (the dispatcher already did)", () => {
    // Assert over the static template only: the Issue/PRD bodies are
    // caller-supplied and may legitimately mention "in-progress" (the dispatch
    // PRD itself does), so banning the substring across the filled output would
    // be a false failure. The property under test is that the template's own
    // prose never tells the agent to set that status.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt).not.toContain("in-progress");
  });

  it("embeds a body verbatim even when it mentions in-progress", () => {
    const wordy: DispatchIssue = {
      ...issue,
      body: "Flip each Issue to in-progress the moment it's dispatched.",
    };
    expect(buildImplementorPrompt({ issue: wordy, ...context })).toContain(
      wordy.body,
    );
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });

  it("includes the Issue and PRD titles for orientation", () => {
    const prompt = build();
    expect(prompt).toContain(issue.title);
    expect(prompt).toContain(prdTitle);
  });
});
