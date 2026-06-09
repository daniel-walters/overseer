import type { DispatchIssue } from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";

/**
 * Whether a single Issue can have a reviewer spawned for it, and — when it
 * can't — a human-readable reason for the modal preview to show.
 *
 * The review counterpart to the dispatch {@link import("../dispatch/frontier.js").Classification}:
 * dispatch classifies a whole PRD's frontier into spawn/queued/blocked/skipped,
 * while review is a deliberate act on one selected Issue, so its classifier is a
 * single yes/no with a reason rather than a per-PRD sweep.
 */
export type ReviewEligibility =
  | { readonly reviewable: true }
  | { readonly reviewable: false; readonly reason: string };

/**
 * Classify whether the selected Issue is eligible for review. An Issue is
 * reviewable exactly when it is `ready-for-review` *and* carries both the
 * implementor's recorded worktree and branch — the two handoff fields the
 * reviewer reads to check out the code and merge it (ADR 0006). Without them the
 * reviewer has nothing to check out or merge, so the Issue is skipped with a
 * reason rather than spawning a reviewer that can only fail.
 *
 * A recorded deviation does NOT make an Issue ineligible: the AI review loop
 * runs first regardless of a deviation (CONTEXT.md, "Review outcome"). The
 * deviation only steers the *outcome* (straight to `human-review`), which the
 * reviewer prompt encodes — not whether a reviewer spawns at all.
 *
 * Pure data-in/data-out, no I/O — mirrors {@link import("../dispatch/frontier.js").computeFrontier}.
 */
export function classifyReviewability(issue: DispatchIssue): ReviewEligibility {
  if (issue.status !== Status.READY_FOR_REVIEW) {
    return {
      reviewable: false,
      reason: `status is "${issue.status ?? "(none)"}", not ${Status.READY_FOR_REVIEW}`,
    };
  }

  if (issue.worktree === undefined || issue.worktree.trim() === "") {
    return { reviewable: false, reason: "no worktree recorded on the Issue" };
  }

  if (issue.branch === undefined || issue.branch.trim() === "") {
    return { reviewable: false, reason: "no branch recorded on the Issue" };
  }

  return { reviewable: true };
}
