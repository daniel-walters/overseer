import {
  readDispatchIssue,
  readPrdMeta,
  type DispatchIssue,
} from "../dispatch/reader.js";
import type { ReviewEligibility } from "./eligibility.js";

/**
 * The classified review preview the App renders and, on confirm, hands back to
 * the reviewer to act on: the frozen target Issue plus its eligibility verdict.
 *
 * The review counterpart to a dispatch {@link import("../dispatch/frontier.js").FrontierEntry}:
 * a `r` press captures this once so a live re-scan under the open modal can't
 * re-point the preview or the spawn at a different Issue.
 */
export interface ReviewPreview {
  /** The selected Issue, frozen at preview-open time. */
  readonly issue: DispatchIssue;
  /** Whether a reviewer can be spawned for it, with a reason when it can't. */
  readonly eligibility: ReviewEligibility;
  /**
   * The PRD context the reviewer prompt needs, frozen alongside the Issue. Held
   * on the preview itself — not in a mutable reader cache — so the Issue acted
   * on and the PRD context built into its prompt can never come from different
   * reads (a hazard once the ADR 0005 reactor previews more than one Issue).
   */
  readonly prdTitle: string;
  readonly prdBody: string;
  /** The PRD feature branch the clean review path merges into. */
  readonly featureBranch: string;
}

/**
 * One Issue resolved for review: the Issue itself (with the implementor's
 * recorded worktree, branch, and any deviation) plus the parent PRD context the
 * reviewer prompt needs. Produced by {@link readReviewTarget}.
 *
 * The review counterpart to the dispatch {@link import("../dispatch/reader.js").DispatchView}:
 * dispatch reads a whole PRD's frontier, while review acts on the single
 * selected Issue, so the review reader narrows a PRD view down to one Issue.
 */
export interface ReviewTarget {
  /** The selected Issue, as the dispatch reader produced it. */
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
}

/**
 * Resolve one Issue in a PRD directory into a {@link ReviewTarget}, reusing the
 * dispatch reader so the review and dispatch edges parse Issue frontmatter
 * identically (status, repo, worktree, branch, deviation, bodies). Review acts
 * on one selected Issue, so this reads only that Issue file plus the PRD's
 * `prd.md` — not the whole directory — avoiding an N+1 parse of every sibling on
 * each `r` press.
 *
 * Total, like the dispatcher's `readFrontier`: the root is filesystem-watched
 * and changes under the TUI, so a `r` press can race a deletion. A vanished PRD
 * directory (or an Issue id no longer present) yields `undefined` — the preview
 * renders nothing rather than letting an exception escape the Ink input handler.
 */
export function readReviewTarget(
  prdDir: string,
  issueId: string,
): ReviewTarget | undefined {
  try {
    const { prdTitle, prdBody } = readPrdMeta(prdDir);
    const issue = readDispatchIssue(prdDir, issueId);
    return { issue, prdTitle, prdBody };
  } catch {
    // The PRD dir, its prd.md, or the Issue file vanished from the watched root.
    return undefined;
  }
}
