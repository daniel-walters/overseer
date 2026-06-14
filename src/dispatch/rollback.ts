import { join } from "node:path";
import { writeStatus } from "../issueFile.js";
import { readReviewTarget } from "../review/reviewReader.js";
import type { DispatchIssue } from "./reader.js";
import { rollBackStatus } from "./failureLog.js";
import { Status } from "./status.js";
import type { Rollback } from "../ui/App.js";

/**
 * The active → awaiting transition the orphan rollback writes, the *inverse* of
 * the flip each spawn edge performs before launching: an `in-progress` orphan
 * rolls back to `ready-for-agent` (re-entering the implementor frontier) and an
 * `in-review` orphan to `ready-for-review` (re-entering the review frontier).
 * Anything else is not an active status and has no awaiting target.
 */
const AWAITING: Partial<Record<string, Status>> = {
  [Status.IN_PROGRESS]: Status.READY_FOR_AGENT,
  [Status.IN_REVIEW]: Status.READY_FOR_REVIEW,
};

/** The single I/O seam the rollback edge depends on. */
export interface RollbackDeps {
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
}

/**
 * Roll an orphaned Issue back onto its frontier so the normal spawn edge can
 * re-pick it up. The recovery half of orphan reconciliation (ADR 0009): given an
 * orphan in an active status, compute its awaiting target and write it through
 * the status seam — the *same* best-effort transition the launch-failure
 * rollback performs ({@link rollBackStatus}), shared rather than duplicated so
 * the lock-and-rollback contract can't drift.
 *
 * It does **not** spawn: after the rollback the Issue is back at its awaiting
 * status and the normal spawn edge (the Reactor if auto-run is on, `d`/`r` if
 * off) re-picks it up. On re-spawn the sidecar overwrites the stale handle, so
 * no stale-handle cleanup is needed.
 *
 * An Issue not in an active status has no awaiting target, so it is left
 * untouched — a defensive guard; the UI already gates `R` on the orphan marker.
 */
export function rollBackOrphan(issue: DispatchIssue, deps: RollbackDeps): void {
  const awaiting = issue.status === undefined ? undefined : AWAITING[issue.status];
  if (awaiting === undefined) return;
  rollBackStatus(deps.writeStatus, issue.path, awaiting);
}

/**
 * The frozen re-dispatch preview the App captures on `R` and hands back on
 * confirm — just the orphaned Issue, resolved once so a live re-scan under the
 * open modal can't re-point the rollback at a different Issue. The orphan
 * counterpart to a {@link import("../review/reviewReader.js").ReviewPreview},
 * minus the review-only context (eligibility, PRD body, feature branch): a
 * rollback only rewrites one status, it builds no prompt.
 */
export interface RedispatchPreview {
  /** The orphaned Issue, frozen at preview-open time. */
  readonly issue: DispatchIssue;
}

/**
 * Build the production {@link Rollback} seam the App drives at the Issue level,
 * the recovery counterpart to the {@link import("../review/reviewer.js").createReviewer}
 * dispatcher/reviewer wiring. It resolves a (PRD id, Issue id) to the orphaned
 * Issue for the re-dispatch preview, and on confirm rolls that Issue back onto
 * its frontier via {@link rollBackOrphan} — no spawn, no git, no prompt.
 *
 * Both entry points are total, like the reviewer's: the root is
 * filesystem-watched and changes under the TUI, so `R` and confirm can race a
 * deletion. `readRollback` reuses the review reader to resolve one Issue and
 * reports a vanished PRD/Issue as `undefined` (the preview renders nothing); the
 * status-writer is the shared {@link import("../issueFile.js").writeStatus}, not
 * a seam, exactly as the reviewer does — only the genuinely external edges are
 * injected, and a rollback has none.
 */
export function createRollback(root: string): Rollback {
  return {
    readRollback(prdId: string, issueId: string): RedispatchPreview | undefined {
      const target = readReviewTarget(join(root, prdId), issueId);
      if (!target) return undefined;
      return { issue: target.issue };
    },

    rollback(preview: RedispatchPreview): void {
      rollBackOrphan(preview.issue, { writeStatus });
    },
  };
}
