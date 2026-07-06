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

  function reviewable(name: string, deviation?: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      `---
title: A
status: ready-for-review
repo: /repos/x
worktree: /wt/x
branch: feat-x${deviation ? `\ndeviation: "${deviation}"` : ""}
---

Body.
`,
    );
    return path;
  }

  it("routes a non-deviating Issue to human-review with reason non-convergence", () => {
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

  it("escalates a deviating Issue with reason deviation, not non-convergence", () => {
    // Deviation takes precedence: an Issue that both deviated and failed to
    // converge surfaces the deviation, the more important cause — the auditor
    // recorded it before review, so the field is present at this escalation point.
    const path = reviewable("001.md", "swapped the queue for a poll loop");

    escalateNonConvergence(path, 3, 3, "swapped the queue for a poll loop");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("human_review_reason: deviation");
    expect(after).not.toContain("human_review_reason: non-convergence");
  });

  it("folds the deviation and the secondary non-convergence cause into the note", () => {
    const path = reviewable("001.md", "swapped the queue for a poll loop");

    escalateNonConvergence(path, 3, 3, "swapped the queue for a poll loop");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("human_review_note:");
    // The recorded deviation is quoted so the human reads one coherent reason.
    expect(after).toContain("swapped the queue for a poll loop");
    // The secondary cause (review also did not converge) is named, with the tally.
    expect(after).toContain("3 of 3");
  });

  it("treats a blank deviation as absent (escalates non-convergence)", () => {
    const path = reviewable("001.md");

    escalateNonConvergence(path, 3, 3, "   ");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("human_review_reason: non-convergence");
  });
});
