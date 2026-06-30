import {
  readDispatchIssue,
  readPrdMeta,
  type DispatchIssue,
} from "../dispatch/reader.js";
import type { AuditEligibility } from "./eligibility.js";

/**
 * The classified audit preview the App renders and, on confirm, hands back to
 * the auditor to act on: the frozen target Issue plus its auditability verdict
 * and the PRD context the auditor prompt needs.
 *
 * The audit counterpart to {@link import("../review/reviewReader.js").ReviewPreview}:
 * a `c` press captures this once so a live re-scan under the open modal can't
 * re-point the preview or the spawn at a different Issue.
 */
export interface AuditPreview {
  /** The selected Issue, frozen at preview-open time. */
  readonly issue: DispatchIssue;
  /** Whether an auditor can be spawned for it, with a reason when it can't. */
  readonly eligibility: AuditEligibility;
  /**
   * The PRD context the auditor prompt needs (the plan the diff is judged
   * against), frozen alongside the Issue. Held on the preview itself — not in a
   * mutable reader cache — so the Issue audited and the PRD context built into its
   * prompt can never come from different reads.
   */
  readonly prdTitle: string;
  readonly prdBody: string;
}

/**
 * One Issue resolved for audit: the Issue itself (with the implementor's recorded
 * worktree) plus the parent PRD context the auditor prompt needs. Produced by
 * {@link readAuditTarget}, the audit counterpart to
 * {@link import("../review/reviewReader.js").ReviewTarget}.
 */
export interface AuditTarget {
  /** The selected Issue, as the dispatch reader produced it. */
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
}

/**
 * Resolve one Issue in a PRD directory into an {@link AuditTarget}, reusing the
 * dispatch reader so the audit and dispatch edges parse Issue frontmatter
 * identically (status, repo, worktree, branch, bodies). Audit acts on the single
 * selected Issue, so this reads only that Issue file plus the PRD's `prd.md` — not
 * the whole directory — avoiding an N+1 parse of every sibling on each `c` press.
 *
 * Total, like the reviewer's `readReviewTarget`: the root is filesystem-watched
 * and changes under the TUI, so a `c` press can race a deletion. A vanished PRD
 * directory (or an Issue id no longer present) yields `undefined` — the preview
 * renders nothing rather than letting an exception escape the Ink input handler.
 */
export function readAuditTarget(
  prdDir: string,
  issueId: string,
): AuditTarget | undefined {
  try {
    const { prdTitle, prdBody } = readPrdMeta(prdDir);
    const issue = readDispatchIssue(prdDir, issueId);
    return { issue, prdTitle, prdBody };
  } catch {
    // The PRD dir, its prd.md, or the Issue file vanished from the watched root.
    return undefined;
  }
}
