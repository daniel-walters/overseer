import { describe, it, expect } from "vitest";
import { classifyAuditability } from "./eligibility.js";
import type { DispatchIssue } from "../dispatch/reader.js";

/** A ready-for-audit Issue with the full implementor handoff recorded. */
const base: DispatchIssue = {
  id: "001.md",
  title: "x",
  status: "ready-for-audit",
  blockedBy: [],
  repo: "/repos/alpha",
  worktree: "/wt/issue",
  branch: "issue-branch",
  deviation: undefined,
  reviewVerdict: undefined,
  slice: undefined,
  reviewFindings: undefined,
  reviewTolerated: undefined,
  body: "",
  path: "/root/alpha/001.md",
};

describe("classifyAuditability", () => {
  it("is auditable when ready-for-audit with a repo and worktree", () => {
    expect(classifyAuditability(base)).toEqual({ auditable: true });
  });

  it("is auditable even without a recorded branch (the auditor never merges)", () => {
    // The divergence from the reviewer (ADR 0026): the auditor reads the worktree
    // diff but never merges, so a missing branch must not block the audit.
    expect(classifyAuditability({ ...base, branch: undefined })).toEqual({
      auditable: true,
    });
  });

  it("is not auditable unless the status is ready-for-audit", () => {
    const result = classifyAuditability({ ...base, status: "in-audit" });
    expect(result).toMatchObject({ auditable: false });
    if (!result.auditable) expect(result.reason).toMatch(/in-audit/);
  });

  it("is not auditable without a recorded worktree", () => {
    const result = classifyAuditability({ ...base, worktree: undefined });
    expect(result).toMatchObject({ auditable: false });
    if (!result.auditable) expect(result.reason).toMatch(/worktree/);
  });

  it("is not auditable without a recorded repo", () => {
    const result = classifyAuditability({ ...base, repo: undefined });
    expect(result).toMatchObject({ auditable: false });
    if (!result.auditable) expect(result.reason).toMatch(/repo/);
  });
});
