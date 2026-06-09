import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
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
 * reviewable exactly when it is `ready-for-review`, carries both the
 * implementor's recorded worktree and branch — the two handoff fields the
 * reviewer reads to check out the code and merge it (ADR 0006) — *and* names the
 * `repo` the reviewer is launched in. Without any of these the reviewer has
 * nothing to check out, merge, or run in, so the Issue is skipped with a reason
 * rather than spawning (or, for a missing repo, silently failing to spawn) a
 * reviewer that can only fail.
 *
 * Repo is checked here, not just in the spawn runner, so a missing repo surfaces
 * as a visible skip reason in the preview — mirroring how the dispatch frontier
 * surfaces an invalid/missing repo rather than letting the runner no-op
 * silently after the user has confirmed.
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

  if (!hasValue(issue.worktree)) {
    return { reviewable: false, reason: "no worktree recorded on the Issue" };
  }

  if (!hasValue(issue.branch)) {
    return { reviewable: false, reason: "no branch recorded on the Issue" };
  }

  if (!hasValue(issue.repo)) {
    return { reviewable: false, reason: "no repo recorded on the Issue" };
  }

  return { reviewable: true };
}
