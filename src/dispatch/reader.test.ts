import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readDispatchView } from "./reader.js";
import type { DispatchIssue } from "./reader.js";

const checkoutFlow = fileURLToPath(
  new URL("./__fixtures__/dispatch/checkout-flow", import.meta.url),
);

function issueById(
  issues: readonly DispatchIssue[],
  id: string,
): DispatchIssue {
  const issue = issues.find((i) => i.id === id);
  if (!issue) throw new Error(`no Issue with id "${id}"`);
  return issue;
}

describe("readDispatchView", () => {
  it("reads each Issue's raw status, repo, and blocked_by from a PRD directory", () => {
    const view = readDispatchView(checkoutFlow);

    const payment = issueById(view.issues, "002-payment-intent.md");
    expect(payment.status).toBe("ready-for-agent");
    expect(payment.repo).toBe("/repos/backend");
    expect(payment.blockedBy).toEqual(["001-cart-totals.md"]);
  });

  it("treats an absent repo as undefined and absent blocked_by as empty", () => {
    const view = readDispatchView(checkoutFlow);

    const cartTotals = issueById(view.issues, "001-cart-totals.md");
    expect(cartTotals.blockedBy).toEqual([]);

    const button = issueById(view.issues, "003-checkout-button.md");
    expect(button.repo).toBeUndefined();
  });

  it("keeps blocked_by entries as full sibling filenames, prefix and all", () => {
    const view = readDispatchView(checkoutFlow);

    const button = issueById(view.issues, "003-checkout-button.md");
    // Full filenames are the reference handle; the NNN- prefix is never split off.
    expect(button.blockedBy).toEqual([
      "001-cart-totals.md",
      "002-payment-intent.md",
    ]);
  });

  it("reads the Issue title from frontmatter, falling back to the filename", () => {
    const view = readDispatchView(checkoutFlow);

    expect(issueById(view.issues, "002-payment-intent.md").title).toBe(
      "Payment intent",
    );
    // 003 has no title frontmatter ⇒ the filename stands in (no crash).
    expect(issueById(view.issues, "003-checkout-button.md").title).toBe(
      "003-checkout-button.md",
    );
  });

  it("reads the PRD title from frontmatter", () => {
    const view = readDispatchView(checkoutFlow);
    expect(view.prdTitle).toBe("Checkout Flow");
  });

  it("captures the PRD body and each Issue's body and file path", () => {
    const view = readDispatchView(checkoutFlow);

    expect(view.prdBody).toContain("Let a user pay for the items in their cart");

    const cartTotals = issueById(view.issues, "001-cart-totals.md");
    expect(cartTotals.body).toContain("Compute the cart total including tax");
    expect(cartTotals.path).toContain("checkout-flow/001-cart-totals.md");
  });

  it("orders Issues by their NNN- filename prefix", () => {
    const view = readDispatchView(checkoutFlow);

    expect(view.issues.map((i) => i.id)).toEqual([
      "001-cart-totals.md",
      "002-payment-intent.md",
      "003-checkout-button.md",
      "004-receipt-email.md",
    ]);
  });

  it("reads the implementor handoff fields worktree, branch, and deviation", () => {
    const view = readDispatchView(checkoutFlow);

    const receipt = issueById(view.issues, "004-receipt-email.md");
    expect(receipt.worktree).toBe(
      "/Users/daniel/.worktrees/worktree-blue-cat-fox",
    );
    expect(receipt.branch).toBe("worktree-blue-cat-fox");
    expect(receipt.deviation).toBe(
      "Used a queue instead of inline send to avoid blocking the request.",
    );
  });

  it("treats absent worktree, branch, and deviation as undefined", () => {
    const view = readDispatchView(checkoutFlow);

    const cartTotals = issueById(view.issues, "001-cart-totals.md");
    expect(cartTotals.worktree).toBeUndefined();
    expect(cartTotals.branch).toBeUndefined();
    expect(cartTotals.deviation).toBeUndefined();
  });

  it("reads a scalar blocked_by as a single-entry list rather than dropping it", () => {
    const view = readDispatchView(checkoutFlow);

    // A bare-string blocked_by is malformed but still names a dependency; the
    // reader keeps it (fail-safe) instead of silently parsing it to [].
    const receipt = issueById(view.issues, "004-receipt-email.md");
    expect(receipt.blockedBy).toEqual(["002-payment-intent.md"]);
  });
});
