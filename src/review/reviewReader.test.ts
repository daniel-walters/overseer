import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readReviewTarget } from "./reviewReader.js";

const checkoutFlow = fileURLToPath(
  new URL("../dispatch/__fixtures__/dispatch/checkout-flow", import.meta.url),
);

describe("readReviewTarget", () => {
  it("reads the selected Issue with its handoff fields plus PRD context", () => {
    const target = readReviewTarget(checkoutFlow, "004-receipt-email.md");
    if (!target) throw new Error("expected a review target");

    expect(target.issue.id).toBe("004-receipt-email.md");
    expect(target.issue.status).toBe("ready-for-review");
    expect(target.issue.worktree).toBe(
      "/Users/daniel/.worktrees/worktree-blue-cat-fox",
    );
    expect(target.issue.branch).toBe("worktree-blue-cat-fox");
    expect(target.issue.deviation).toContain("queue instead of inline send");
  });

  it("carries the parent PRD's title and body for the prompt", () => {
    const target = readReviewTarget(checkoutFlow, "004-receipt-email.md");
    if (!target) throw new Error("expected a review target");

    expect(target.prdTitle).toBe("Checkout Flow");
    expect(target.prdBody).toContain("Let a user pay for the items in their cart");
  });

  it("returns undefined for an Issue id that is not in the PRD", () => {
    expect(readReviewTarget(checkoutFlow, "999-ghost.md")).toBeUndefined();
  });

  it("returns undefined instead of throwing when the PRD dir is gone", () => {
    const gone = fileURLToPath(new URL("./__fixtures__/does-not-exist", import.meta.url));
    expect(() => readReviewTarget(gone, "001-a.md")).not.toThrow();
    expect(readReviewTarget(gone, "001-a.md")).toBeUndefined();
  });
});
