import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanBoard } from "./scanner.js";
import type { PRD } from "./model.js";

const boardFixture = fileURLToPath(
  new URL("./__fixtures__/board", import.meta.url),
);

function prdById(prds: readonly PRD[], id: string): PRD {
  const prd = prds.find((p) => p.id === id);
  if (!prd) throw new Error(`no PRD with id "${id}" in board`);
  return prd;
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
