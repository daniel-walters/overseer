import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDispatchView, readDispatchIssue } from "./reader.js";
import type { DispatchIssue } from "./reader.js";

const checkoutFlow = fileURLToPath(
  new URL("./__fixtures__/dispatch/checkout-flow", import.meta.url),
);

/** Write a throwaway PRD dir with a prd.md and the given Issue files. */
function tmpPrd(issues: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "overseer-reader-"));
  writeFileSync(join(dir, "prd.md"), "---\ntitle: Tmp\n---\nbody\n");
  for (const [name, content] of Object.entries(issues)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

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

  it("treats a blank deviation as undefined so it does not foreclose auto-merge", () => {
    // An empty-string deviation is not a real deviation; only a non-blank note
    // should force human review (its mere presence is the gate).
    const dir = tmpPrd({
      "001-empty.md": '---\nstatus: ready-for-review\ndeviation: ""\n---\nbody\n',
      "002-bare.md": "---\nstatus: ready-for-review\ndeviation:\n---\nbody\n",
    });
    const view = readDispatchView(dir);
    expect(issueById(view.issues, "001-empty.md").deviation).toBeUndefined();
    expect(issueById(view.issues, "002-bare.md").deviation).toBeUndefined();
  });

  it("reads review_verdict from frontmatter onto the read model", () => {
    // The clean-review verdict the pass agent writes (ADR 0019): Overseer reads
    // it off the in-review Issue to know the merge → done resolve may run.
    const dir = tmpPrd({
      "001-clean.md": "---\nstatus: in-review\nreview_verdict: clean\n---\nbody\n",
    });
    expect(readDispatchIssue(dir, "001-clean.md").reviewVerdict).toBe("clean");
  });

  it("treats an absent or blank review_verdict as undefined", () => {
    // No verdict (a fresh in-review pass still running) and a blank one are both
    // "no verdict yet" — only a real value moves the Issue onto the resolve frontier.
    const dir = tmpPrd({
      "001-none.md": "---\nstatus: in-review\n---\nbody\n",
      "002-blank.md": '---\nstatus: in-review\nreview_verdict: ""\n---\nbody\n',
    });
    expect(readDispatchIssue(dir, "001-none.md").reviewVerdict).toBeUndefined();
    expect(readDispatchIssue(dir, "002-blank.md").reviewVerdict).toBeUndefined();
  });

  it("reads review_findings (the prior-pass ledger) onto the read model", () => {
    // The findings ledger a findings-exit pass writes (ADR 0024): the next fresh
    // pass reads it off the Issue to confirm those fixes landed.
    const dir = tmpPrd({
      "001-fixed.md":
        '---\nstatus: ready-for-review\nreview_findings: "Unvalidated parser input"\n---\nbody\n',
    });
    expect(readDispatchIssue(dir, "001-fixed.md").reviewFindings).toBe(
      "Unvalidated parser input",
    );
  });

  it("treats an absent or blank review_findings as undefined", () => {
    // A first pass (no prior findings) and a blank field both read as "no ledger"
    // — the next prompt simply carries no confirm-closure step.
    const dir = tmpPrd({
      "001-none.md": "---\nstatus: ready-for-review\n---\nbody\n",
      "002-blank.md":
        '---\nstatus: ready-for-review\nreview_findings: ""\n---\nbody\n',
    });
    expect(
      readDispatchIssue(dir, "001-none.md").reviewFindings,
    ).toBeUndefined();
    expect(
      readDispatchIssue(dir, "002-blank.md").reviewFindings,
    ).toBeUndefined();
  });

  it("reads review_tolerated (the merge's tolerated manifest) onto the read model", () => {
    // The single-line manifest a clean-with-tolerated exit writes (ADR 0027):
    // what the merge waved through, read off the Issue the same way review_findings
    // is — present/blank/absent, no structured parsing (ADR 0024).
    const dir = tmpPrd({
      "001-merged.md":
        '---\nstatus: done\nreview_tolerated: "style:low — two trailing-comma nits"\n---\nbody\n',
    });
    expect(readDispatchIssue(dir, "001-merged.md").reviewTolerated).toBe(
      "style:low — two trailing-comma nits",
    );
  });

  it("treats an absent or blank review_tolerated as undefined", () => {
    // A genuinely zero-findings merge (no manifest) and a blank field both read as
    // "nothing tolerated" — mirroring review_findings' blank-as-absent rule.
    const dir = tmpPrd({
      "001-none.md": "---\nstatus: done\n---\nbody\n",
      "002-blank.md": '---\nstatus: done\nreview_tolerated: ""\n---\nbody\n',
    });
    expect(readDispatchIssue(dir, "001-none.md").reviewTolerated).toBeUndefined();
    expect(
      readDispatchIssue(dir, "002-blank.md").reviewTolerated,
    ).toBeUndefined();
  });

  it("does not throw on malformed frontmatter; reads the fields as absent", () => {
    // A `deviation:` value with an unquoted ': ' is invalid YAML. The reader
    // must degrade to absent fields rather than throwing out of the read.
    const dir = tmpPrd({
      "001-bad.md": "---\nstatus: ready-for-review\ndeviation: Used a cache: it is faster\n---\nthe body\n",
    });
    const issue = readDispatchIssue(dir, "001-bad.md");
    expect(issue.status).toBeUndefined();
    expect(issue.deviation).toBeUndefined();
    expect(issue.body).toContain("the body");
  });
});
