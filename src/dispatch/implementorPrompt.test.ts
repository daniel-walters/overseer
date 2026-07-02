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
  reviewVerdict: undefined,
  slice: undefined,
  reviewFindings: undefined,
  reviewTolerated: undefined,
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

  it("instructs the agent to read and follow the repo's CLAUDE.md and use its skills", () => {
    // Assert over the static template (empty Issue/PRD) so following the target
    // repo's own CLAUDE.md and `.claude/skills/` is a property of the prompt
    // itself — not something a caller-supplied body happened to mention. This is
    // what stops a bare `claude --bg` implementor from ignoring repo-specific
    // conventions that are loaded but not otherwise prioritised.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt.toLowerCase()).toContain(".claude/skills");
  });

  it("instructs the agent to commit to the worktree with no PR", () => {
    const prompt = build().toLowerCase();
    expect(prompt).toContain("commit");
    expect(prompt).toMatch(/no pull request|no pr|do not open a (pull request|pr)/);
  });

  it("instructs the agent to park the Issue at ready-for-audit on completion", () => {
    // The implementor now hands off to the auditor, not the reviewer (ADR 0026):
    // it flips to `ready-for-audit`, the awaiting half of the new audit spawn edge.
    const prompt = build();
    expect(prompt).toContain("ready-for-audit");
    // and to write that status into the Issue file in the Overseer root.
    expect(prompt).toContain(issue.path);
  });

  it("does NOT instruct the agent to park at ready-for-review (that's now the auditor's flip)", () => {
    // The implementor stops one step earlier than before: it parks at
    // ready-for-audit, and the auditor flips in-audit → ready-for-review. Assert
    // over the static template only, since caller-supplied bodies may mention it.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt).not.toContain("ready-for-review");
  });

  it("does NOT instruct the agent to write in-review (that's the reviewer's flip)", () => {
    // Assert over the static template only, since caller-supplied bodies may
    // mention in-review.
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

  it("does NOT instruct the agent to record a deviation field (the auditor owns that now)", () => {
    // There is now exactly one writer of the `deviation` field — the auditor, a
    // fresh-eyes agent — so the implementor must not grade its own homework (ADR
    // 0026). Assert over the static template only, since caller-supplied bodies may
    // legitimately mention the word.
    const prompt = buildImplementorPrompt({
      issue: { ...issue, body: "", title: "" },
      prdTitle: "",
      prdBody: "",
      repo: context.repo,
      featureBranch: context.featureBranch,
    });
    expect(prompt.toLowerCase()).not.toContain("deviation");
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
