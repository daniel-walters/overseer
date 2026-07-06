import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";

/**
 * Whether a single Issue can have an auditor spawned for it, and — when it can't
 * — a human-readable reason for a preview to show. The audit counterpart to
 * {@link import("../review/eligibility.js").ReviewEligibility}.
 */
export type AuditEligibility =
  | { readonly auditable: true }
  | { readonly auditable: false; readonly reason: string };

/**
 * Classify whether the selected Issue is eligible for audit. An Issue is
 * auditable exactly when it is `ready-for-audit`, carries the implementor's
 * recorded `worktree` — the diff the auditor checks out to compare against the
 * plan (ADR 0006 / 0026) — *and* names the `repo` the auditor is launched in.
 * Without any of these the auditor has nothing to check out or run in, so the
 * Issue is skipped with a reason rather than spawning an auditor that can only
 * fail.
 *
 * Unlike {@link import("../review/eligibility.js").classifyReviewability}, the
 * branch is **not** required: the auditor never merges (ADR 0026), so it reads
 * the worktree diff but never the branch. A normal implementor records both
 * `worktree` and `branch` in the same edit, so this is the same handoff in
 * practice — but the auditor's contract depends only on the worktree.
 *
 * Pure data-in/data-out, no I/O — mirrors the dispatch frontier and the review
 * classifier.
 */
export function classifyAuditability(issue: DispatchIssue): AuditEligibility {
  if (issue.status !== Status.READY_FOR_AUDIT) {
    return {
      auditable: false,
      reason: `status is "${issue.status ?? "(none)"}", not ${Status.READY_FOR_AUDIT}`,
    };
  }

  if (!hasValue(issue.worktree)) {
    return { auditable: false, reason: "no worktree recorded on the Issue" };
  }

  if (!hasValue(issue.repo)) {
    return { auditable: false, reason: "no repo recorded on the Issue" };
  }

  return { auditable: true };
}
