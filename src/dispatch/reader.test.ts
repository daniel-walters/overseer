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
});
