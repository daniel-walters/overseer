import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalateNonConvergence } from "./escalate.js";

describe("escalateNonConvergence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-escalate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reviewable(name: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      `---
title: A
status: ready-for-review
repo: /repos/x
worktree: /wt/x
branch: feat-x
---

Body.
`,
    );
    return path;
  }

  it("routes the Issue to human-review with reason non-convergence", () => {
    const path = reviewable("001.md");

    escalateNonConvergence(path, 3, 3);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("human_review_reason: non-convergence");
  });

  it("records a note carrying the pass tally so the human knows why", () => {
    const path = reviewable("001.md");

    escalateNonConvergence(path, 3, 3);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("human_review_note:");
    // The cap and the count are folded into the note.
    expect(after).toContain("3 of 3");
  });

  it("does not throw when the Issue file has vanished (raced a deletion)", () => {
    const path = join(dir, "gone.md"); // never created
    expect(() => escalateNonConvergence(path, 3, 3)).not.toThrow();
  });
});
