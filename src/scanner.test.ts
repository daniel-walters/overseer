import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanBoard } from "./scanner.js";
import type { PRD, Issue } from "./model.js";

const boardFixture = fileURLToPath(
  new URL("./__fixtures__/board", import.meta.url),
);

function prdById(prds: readonly PRD[], id: string): PRD {
  const prd = prds.find((p) => p.id === id);
  if (!prd) throw new Error(`no PRD with id "${id}" in board`);
  return prd;
}

function issueById(issues: readonly Issue[], id: string): Issue {
  const issue = issues.find((i) => i.id === id);
  if (!issue) throw new Error(`no Issue with id "${id}"`);
  return issue;
}

describe("scanBoard", () => {
  it("treats a directory containing prd.md as a PRD, reading its title and status", () => {
    const board = scanBoard(boardFixture);

    const auth = prdById(board.prds, "auth-system");
    expect(auth.title).toBe("Authentication System");
    expect(auth.lane).toBe("in-progress");
  });

  it("ignores a directory that has no prd.md", () => {
    const board = scanBoard(boardFixture);

    expect(board.prds.map((p) => p.id)).not.toContain("not-a-prd");
  });

  it("falls back to the directory name when title frontmatter is absent", () => {
    const board = scanBoard(boardFixture);

    const prd = prdById(board.prds, "no-title-dir-name");
    expect(prd.title).toBe("no-title-dir-name");
  });

  it("puts a PRD with missing status in the unsorted lane", () => {
    const board = scanBoard(boardFixture);

    const prd = prdById(board.prds, "no-status-prd");
    expect(prd.lane).toBe("unsorted");
  });

  it("puts a PRD with an unrecognized status in the unsorted lane", () => {
    const board = scanBoard(boardFixture);

    const prd = prdById(board.prds, "bad-status-prd");
    expect(prd.lane).toBe("unsorted");
  });

  it("maps a ready-for-agent PRD to the ready lane with an agent badge", () => {
    const board = scanBoard(boardFixture);

    const prd = prdById(board.prds, "billing");
    expect(prd.lane).toBe("ready");
    expect(prd.readyFor).toBe("agent");
  });
});

describe("scanBoard Issues", () => {
  function authIssues(): readonly Issue[] {
    return prdById(scanBoard(boardFixture).prds, "auth-system").issues;
  }

  it("parses every non-prd.md markdown file as an Issue of the PRD", () => {
    const ids = authIssues().map((i) => i.id);

    expect(ids).toContain("001-password-hashing.md");
    expect(ids).toContain("003-login-form.md");
    expect(ids).not.toContain("prd.md");
  });

  it("identifies an Issue by its filename and reads its title and lane", () => {
    const issue = issueById(authIssues(), "003-login-form.md");

    expect(issue.title).toBe("Login form");
    expect(issue.lane).toBe("in-progress");
  });

  it("falls back to the filename slug when an Issue has no title frontmatter", () => {
    const issue = issueById(authIssues(), "007-session-tokens.md");

    expect(issue.title).toBe("session-tokens");
  });

  it("orders Issues within a lane by their NNN- prefix, gaps and all", () => {
    const issues = authIssues();
    const inProgress = issues
      .filter((i) => i.lane === "in-progress")
      .map((i) => i.id);

    // 003 and 007 share the in-progress lane; 004/005/etc. sit elsewhere.
    expect(inProgress).toEqual([
      "003-login-form.md",
      "007-session-tokens.md",
    ]);
  });

  it("splits ready-for-human / ready-for-agent into the ready lane plus a flag", () => {
    const issues = authIssues();

    const human = issueById(issues, "002-oauth-provider.md");
    expect(human.lane).toBe("ready");
    expect(human.readyFor).toBe("human");

    const agent = issueById(issues, "004-rate-limiting.md");
    expect(agent.lane).toBe("ready");
    expect(agent.readyFor).toBe("agent");
  });

  it("falls an Issue with an unrecognized status to the unsorted lane", () => {
    const issue = issueById(authIssues(), "005-mystery.md");

    expect(issue.lane).toBe("unsorted");
    expect(issue.readyFor).toBeUndefined();
  });

  it("yields no Issues for a PRD whose directory holds only prd.md", () => {
    const board = scanBoard(boardFixture);

    expect(prdById(board.prds, "no-status-prd").issues).toEqual([]);
  });
});
