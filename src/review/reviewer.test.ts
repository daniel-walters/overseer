import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewer, type ReviewerDeps } from "./reviewer.js";

const checkoutFlow = fileURLToPath(
  new URL("../dispatch/__fixtures__/dispatch/checkout-flow", import.meta.url),
);

/** Recording seams so we can assert the spawn invocation shape and logging. */
function recordingDeps(overrides: Partial<ReviewerDeps> = {}): ReviewerDeps & {
  spawns: { repo: string; prompt: string }[];
  failures: unknown[];
} {
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: unknown[] = [];
  return {
    spawns,
    failures,
    spawn: (repo, prompt) => spawns.push({ repo, prompt }),
    logFailure: (r) => failures.push(r),
    ...overrides,
  };
}

describe("createReviewer", () => {
  it("reads and classifies the selected Issue's reviewability by id", () => {
    const reviewer = createReviewer(checkoutFlow.replace(/\/checkout-flow$/, ""), recordingDeps());

    // 004 is ready-for-review with a worktree and branch ⇒ reviewable.
    const review004 = reviewer.readReview("checkout-flow", "004-receipt-email.md");
    expect(review004?.eligibility.reviewable).toBe(true);

    // 002 is ready-for-agent ⇒ not reviewable, with a reason.
    const review002 = reviewer.readReview("checkout-flow", "002-payment-intent.md");
    expect(review002?.eligibility.reviewable).toBe(false);
  });

  it("returns undefined for an Issue id that isn't in the PRD", () => {
    const root = checkoutFlow.replace(/\/checkout-flow$/, "");
    const reviewer = createReviewer(root, recordingDeps());
    expect(reviewer.readReview("checkout-flow", "999-ghost.md")).toBeUndefined();
  });

  describe("review (against a writable copy of the fixture)", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "overseer-reviewer-"));
      cpSync(checkoutFlow, join(root, "checkout-flow"), { recursive: true });
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("flips the reviewable Issue to in-review on disk and spawns it in its repo", () => {
      const deps = recordingDeps();
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      const after = readFileSync(
        join(root, "checkout-flow", "004-receipt-email.md"),
        "utf8",
      );
      expect(after).toContain("status: in-review");

      expect(deps.spawns).toHaveLength(1);
      expect(deps.spawns[0]?.repo).toBe("/repos/backend");
    });

    it("builds a prompt carrying the worktree, branch, feature branch, and PRD body", () => {
      const deps = recordingDeps();
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      const prompt = deps.spawns[0]?.prompt ?? "";
      expect(prompt).toContain("worktree-blue-cat-fox"); // recorded worktree/branch
      expect(prompt).toContain("checkout-flow"); // slugified PRD dir = feature branch
      expect(prompt).toContain("Let a user pay for the items in their cart"); // PRD body
      expect(prompt).toContain("/code-review");
    });

    it("rolls the Issue back to ready-for-review and logs when the spawn fails", () => {
      const deps = recordingDeps({
        spawn: () => {
          throw new Error("claude: command not found");
        },
      });
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      const after = readFileSync(
        join(root, "checkout-flow", "004-receipt-email.md"),
        "utf8",
      );
      expect(after).toContain("status: ready-for-review");
      expect(after).not.toContain("in-review");

      expect(deps.failures).toEqual([
        {
          issueId: "004-receipt-email.md",
          repo: "/repos/backend",
          error: "claude: command not found",
        },
      ]);
    });

    it("does not spawn an ineligible Issue even if review is called", () => {
      const deps = recordingDeps();
      const reviewer = createReviewer(root, deps);

      // 002 is ready-for-agent (not reviewable); review must spawn nothing.
      const preview = reviewer.readReview("checkout-flow", "002-payment-intent.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      expect(deps.spawns).toEqual([]);
      const after = readFileSync(
        join(root, "checkout-flow", "002-payment-intent.md"),
        "utf8",
      );
      expect(after).not.toContain("in-review");
    });

    it("does not flip or spawn a candidate whose file vanished after the preview", () => {
      const deps = recordingDeps();
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      rmSync(join(root, "checkout-flow", "004-receipt-email.md"));

      expect(() => reviewer.review(preview)).not.toThrow();
      expect(deps.spawns).toEqual([]);
    });
  });

  describe("resilience to a changing watched root", () => {
    it("returns undefined instead of throwing when the PRD dir is gone", () => {
      const root = mkdtempSync(join(tmpdir(), "overseer-reviewer-"));
      try {
        const reviewer = createReviewer(root, recordingDeps());
        expect(() => reviewer.readReview("ghost-prd", "001-a.md")).not.toThrow();
        expect(reviewer.readReview("ghost-prd", "001-a.md")).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
