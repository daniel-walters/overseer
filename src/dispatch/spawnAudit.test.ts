import { describe, it, expect } from "vitest";
import { describeSpawn } from "./spawnAudit.js";
import type { DispatchIssue } from "./reader.js";
import { buildImplementorPrompt } from "./implementorPrompt.js";
import { buildAuditorPrompt } from "../audit/auditorPrompt.js";
import { buildReviewerPrompt } from "../review/reviewerPrompt.js";
import { DEFAULT_REVIEW_CONFIG } from "../review/reviewConfig.js";

/**
 * `describeSpawn` reads the edge and the target Issue path back out of a built
 * prompt (the only two identifying values the shared `spawn` seam has to log).
 * Driving it through the *real* prompt builders — not hand-written fixtures — is
 * deliberate: it turns this into a drift guard, so if a prompt's opening line or
 * its "Issue file to edit is: <path>" phrasing ever changes, this fails rather
 * than the audit log silently degrading every line to `unknown`.
 */
const issue: DispatchIssue = {
  id: "003-thing.md",
  title: "Thing",
  path: "/Users/x/overseer-board/my-prd/003-thing.md",
  status: undefined,
  blockedBy: [],
  repo: "/Users/x/repo",
  worktree: "/Users/x/repo/.claude/worktrees/thing",
  branch: "thing",
  deviation: undefined,
  reviewVerdict: undefined,
  slice: undefined,
  reviewFindings: undefined,
  reviewTolerated: undefined,
  body: "Do the thing.",
};

describe("describeSpawn", () => {
  it("names the implementor edge and the Issue path from an implementor prompt", () => {
    const prompt = buildImplementorPrompt({
      issue,
      prdTitle: "My PRD",
      prdBody: "Body",
      repo: issue.repo!,
      featureBranch: "my-prd",
    });
    expect(describeSpawn(prompt)).toEqual({
      edge: "implementor",
      issuePath: issue.path,
    });
  });

  it("names the auditor edge and the Issue path from an auditor prompt", () => {
    const prompt = buildAuditorPrompt({ issue, prdTitle: "My PRD", prdBody: "Body" });
    expect(describeSpawn(prompt)).toEqual({ edge: "auditor", issuePath: issue.path });
  });

  it("names the reviewer edge and the Issue path from a reviewer prompt", () => {
    const prompt = buildReviewerPrompt({
      issue,
      prdTitle: "My PRD",
      prdBody: "Body",
      review: DEFAULT_REVIEW_CONFIG,
    });
    expect(describeSpawn(prompt)).toEqual({ edge: "reviewer", issuePath: issue.path });
  });

  it("falls back to `unknown` for an unrecognised prompt, never throwing", () => {
    expect(describeSpawn("some other output entirely")).toEqual({
      edge: "unknown",
      issuePath: "unknown",
    });
  });
});
