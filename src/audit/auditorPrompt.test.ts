import { describe, it, expect } from "vitest";
import { buildAuditorPrompt } from "./auditorPrompt.js";
import type { DispatchIssue } from "../dispatch/reader.js";

const issue: DispatchIssue = {
  id: "001-password-hashing.md",
  title: "Password hashing",
  status: "in-audit",
  blockedBy: [],
  repo: "/Users/daniel/code/backend",
  worktree: "/wt/issue",
  branch: "issue-branch",
  deviation: undefined,
  reviewVerdict: undefined,
  slice: undefined,
  reviewFindings: undefined,
  body: "Hash passwords with argon2id before persisting them.\n\n## AC\n- [ ] argon2id used",
  path: "/root/auth-system/001-password-hashing.md",
};

const prdTitle = "Authentication System";
const prdBody = "## Problem\nUsers cannot sign in.\n\n## Solution\nBuild auth.";

function build(): string {
  return buildAuditorPrompt({ issue, prdTitle, prdBody });
}

/**
 * Assert over the static template only (empty Issue/PRD bodies), so a property is
 * shown to be the prompt's own — not something a caller-supplied body happened to
 * mention. Mirrors the implementor/reviewer prompt tests.
 */
function buildBare(): string {
  return buildAuditorPrompt({
    issue: { ...issue, body: "", title: "" },
    prdTitle: "",
    prdBody: "",
  });
}

describe("buildAuditorPrompt", () => {
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

  it("names the repo to run git in and the recorded worktree to check out", () => {
    const prompt = build();
    expect(prompt).toContain(issue.repo);
    expect(prompt).toContain(issue.worktree);
  });

  it("instructs the agent to check out the recorded worktree", () => {
    const prompt = buildBare().toLowerCase();
    expect(prompt).toContain("check out");
    expect(prompt).toContain("worktree");
  });

  it("instructs comparing the diff against the plan (Issue body + PRD)", () => {
    const prompt = buildBare().toLowerCase();
    expect(prompt).toContain("diff");
    expect(prompt).toContain("plan");
  });

  it("states the leeway rubric: flag a deviation only on a meaningful divergence", () => {
    const prompt = buildBare().toLowerCase();
    // Meaningful divergence: conflicts with / omits / materially exceeds the plan.
    expect(prompt).toMatch(/conflict/);
    expect(prompt).toMatch(/omit/);
    expect(prompt).toMatch(/exceed/);
    // Never flag incidental, behaviour-preserving differences (the leeway side).
    expect(prompt).toMatch(/incidental|behaviour-preserving|behavior-preserving/);
    expect(prompt).toMatch(/renam/);
  });

  it("tells the auditor to lean toward flagging on substantive uncertainty", () => {
    expect(buildBare().toLowerCase()).toMatch(/lean toward flag|unsure|uncertain/);
  });

  it("instructs writing a quoted deviation field only on a meaningful divergence, else nothing", () => {
    const prompt = buildBare();
    expect(prompt).toContain("deviation");
    // Quoted form, so punctuation in the reason can't corrupt the frontmatter.
    expect(prompt).toMatch(/deviation:\s*"/);
    // Conditional: only on a divergence, otherwise omit the field.
    expect(prompt.toLowerCase()).toMatch(/only|otherwise|else/);
  });

  it("instructs the unconditional in-audit → ready-for-review flip", () => {
    const prompt = buildBare();
    expect(prompt).toContain("in-audit");
    expect(prompt).toContain("ready-for-review");
  });

  it("names the Issue file to edit in the Overseer root", () => {
    expect(build()).toContain(issue.path);
  });

  it("does NOT instruct any code review", () => {
    // The auditor judges plan-conformance, never code quality — that is the
    // reviewer's job (ADR 0026). Assert over the static template only.
    const prompt = buildBare().toLowerCase();
    expect(prompt).not.toContain("/code-review");
    expect(prompt).not.toContain("code review");
  });

  it("does NOT instruct any merge", () => {
    const prompt = buildBare().toLowerCase();
    expect(prompt).not.toContain("merge");
  });

  it("does NOT instruct any terminal status write (done / human-review)", () => {
    const prompt = buildBare();
    expect(prompt).not.toContain("done");
    expect(prompt).not.toContain("human-review");
  });

  it("does NOT tell the agent to set in-audit (the trigger already flipped it)", () => {
    // It only flips in-audit → ready-for-review; it must not be told to *set*
    // in-audit. The substring "in-audit" appears as the source of the flip, but
    // never as an instruction to write it — assert the flip is the only mention by
    // checking it is always paired with the onward target.
    const prompt = buildBare();
    // Every occurrence of in-audit is part of the "in-audit → ready-for-review"
    // phrase, never a bare "set in-audit" instruction.
    expect(prompt).not.toMatch(/set\s+`?in-audit/i);
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(build()).toBe(build());
  });

  it("embeds a body verbatim even when it mentions merge or review", () => {
    const wordy: DispatchIssue = {
      ...issue,
      body: "Add a merge button and a code review step to the settings page.",
    };
    expect(
      buildAuditorPrompt({ issue: wordy, prdTitle, prdBody }),
    ).toContain(wordy.body);
  });
});
