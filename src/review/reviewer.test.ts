import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewer, type ReviewerDeps } from "./reviewer.js";
import { createFailedSet } from "../reactor/failedSet.js";
import { DEFAULT_REVIEW_CONFIG } from "./reviewConfig.js";

const checkoutFlow = fileURLToPath(
  new URL("../dispatch/__fixtures__/dispatch/checkout-flow", import.meta.url),
);

/** Recording seams so we can assert the spawn invocation shape and logging. */
function recordingDeps(overrides: Partial<ReviewerDeps> = {}): ReviewerDeps & {
  spawns: { repo: string; prompt: string }[];
  failures: unknown[];
  handles: { issueKey: string; handle: string; reviewPass?: number }[];
} {
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: unknown[] = [];
  const handles: { issueKey: string; handle: string; reviewPass?: number }[] =
    [];
  return {
    spawns,
    failures,
    handles,
    spawn: (repo, prompt) => {
      spawns.push({ repo, prompt });
      return `handle-${repo}`;
    },
    logFailure: (r) => failures.push(r),
    recordHandle: (issueKey, handle, reviewPass) =>
      handles.push({ issueKey, handle, reviewPass }),
    readReviewPass: () => undefined,
    failedSet: createFailedSet(),
    review: DEFAULT_REVIEW_CONFIG,
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

    it("records the reviewer's handle against the Issue's full path", () => {
      const deps = recordingDeps();
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      // The reviewer edge records its handle through the same path as the
      // implementor edge, so the in-review card is as joinable as in-progress.
      // It also records the pass it is driving — the first pass (1) here, since
      // no prior pass is recorded — so the card's `N/cap` marker reads 1/cap.
      expect(deps.handles).toEqual([
        {
          issueKey: join(root, "checkout-flow", "004-receipt-email.md"),
          handle: "handle-/repos/backend",
          reviewPass: 1,
        },
      ]);
    });

    it("drives the next pass by hand: records N+1 from the recorded pass", () => {
      // A manual `r` press is one pass, exactly like an auto-reconcile pass: it
      // reads the pass already recorded for this Issue and records the increment
      // at spawn time. Two passes have run, so this press drives the third.
      const deps = recordingDeps({ readReviewPass: () => 2 });
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      expect(deps.spawns).toHaveLength(1);
      expect(deps.handles[0]?.reviewPass).toBe(3);
    });

    it("escalates to human-review at the cap instead of spawning, deviation taking precedence", () => {
      // The cap is Reactor/keybind-enforced from the count (ADR 0018): a manual
      // `r` on an Issue already at the cap (3 passes recorded, cap 3) must NOT
      // spawn a 4th pass — it escalates to human-review, the same gate the auto
      // path applies. The 004 fixture carries an auditor-recorded deviation, so
      // deviation takes precedence over non-convergence (ADR 0026): the surfaced
      // reason is `deviation`, never `non-convergence`.
      const deps = recordingDeps({ readReviewPass: () => 3 });
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      expect(deps.spawns).toEqual([]); // no 4th pass
      const after = readFileSync(
        join(root, "checkout-flow", "004-receipt-email.md"),
        "utf8",
      );
      expect(after).toContain("status: human-review");
      expect(after).toContain("human_review_reason: deviation");
      expect(after).not.toContain("human_review_reason: non-convergence");
    });

    it("escalates a non-deviating Issue to human-review with reason non-convergence at the cap", () => {
      // Complement to the deviation-precedence test above: an Issue with no
      // auditor-recorded deviation must still surface non-convergence, not
      // deviation. Exercises the driveReviewPass → escalateNonConvergence wiring
      // for the no-deviation branch end-to-end (ADR 0026).
      const deps = recordingDeps({ readReviewPass: () => 3 });
      const reviewer = createReviewer(root, deps);

      // 005 has no deviation field — non-convergence is the only possible reason.
      const preview = reviewer.readReview("checkout-flow", "005-shipping-label.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      expect(deps.spawns).toEqual([]); // no 4th pass
      const after = readFileSync(
        join(root, "checkout-flow", "005-shipping-label.md"),
        "utf8",
      );
      expect(after).toContain("status: human-review");
      expect(after).toContain("human_review_reason: non-convergence");
      expect(after).not.toContain("human_review_reason: deviation");
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
          edge: "reviewer",
        },
      ]);
    });

    it("records a failed manual r launch into the shared failed-set under the reviewer edge", () => {
      // The behaviour change (ADR 0011): a manual `r` launch failure lands in the
      // same session-scoped failed-set the Reactor reads, keyed by the Issue's
      // full path under the reviewer edge — so the next reconcile suppresses its
      // reviewer spawn exactly as it would an automated failure.
      const failedSet = createFailedSet();
      const deps = recordingDeps({
        failedSet,
        spawn: () => {
          throw new Error("claude: command not found");
        },
      });
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      const path = join(root, "checkout-flow", "004-receipt-email.md");
      expect(failedSet.has(path, "reviewer")).toBe(true);
      // The implementor edge for the same Issue is untouched.
      expect(failedSet.has(path, "implementor")).toBe(false);
    });

    it("does not touch the failed-set when a manual r launch succeeds", () => {
      const failedSet = createFailedSet();
      const deps = recordingDeps({ failedSet });
      const reviewer = createReviewer(root, deps);

      const preview = reviewer.readReview("checkout-flow", "004-receipt-email.md");
      if (!preview) throw new Error("expected a preview");
      reviewer.review(preview);

      const path = join(root, "checkout-flow", "004-receipt-email.md");
      expect(failedSet.has(path, "reviewer")).toBe(false);
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
