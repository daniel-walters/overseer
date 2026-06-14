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
 *
 * Keyed on the active-status subtype, not a bare `string`, so adding a third
 * active status to {@link Status} that forgets an entry here is a compile error,
 * not a silent no-op rollback.
 */
const AWAITING: Record<
  typeof Status.IN_PROGRESS | typeof Status.IN_REVIEW,
  Status
> = {
  [Status.IN_PROGRESS]: Status.READY_FOR_AGENT,
  [Status.IN_REVIEW]: Status.READY_FOR_REVIEW,
};

/** The awaiting target for an active status, or `undefined` for any other. */
function awaitingFor(status: string | undefined): Status | undefined {
  if (status === Status.IN_PROGRESS) return AWAITING[Status.IN_PROGRESS];
  if (status === Status.IN_REVIEW) return AWAITING[Status.IN_REVIEW];
  return undefined;
}

/** The single I/O seam the rollback edge depends on. */
export interface RollbackDeps {
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
}

/**
 * Why a rollback did nothing, or that it rolled back — surfaced so the UI can
 * tell the human "recovered" from the silent "nothing to recover" (ADR 0009):
 *
 * - **rolled-back** — the Issue was still active; its status was rolled back.
 * - **advanced** — the Issue is no longer in an active status (its agent wasn't
 *   actually dead and wrote the next status, or another edge advanced it between
 *   the `R` press and confirm). Nothing to recover; left untouched.
 * - **vanished** — the Issue file is gone from the watched root (raced a
 *   deletion). Nothing to recover.
 */
export type RollbackOutcome = "rolled-back" | "advanced" | "vanished";

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
 * untouched and reported `advanced` — the load-bearing safety against acting on
 * a stale verdict: the *caller passes a freshly re-read status*, so an agent
 * that merely looked dead but kept working (and wrote `ready-for-review` /
 * `done` before confirm) is never clobbered back to its frontier.
 */
export function rollBackOrphan(
  issue: DispatchIssue,
  deps: RollbackDeps,
): RollbackOutcome {
  const awaiting = awaitingFor(issue.status);
  if (awaiting === undefined) return "advanced";
  rollBackStatus(deps.writeStatus, issue.path, awaiting);
  return "rolled-back";
}

/**
 * The re-dispatch preview the App captures on `R` and hands back on confirm. It
 * freezes the orphan's *identity* — `prdId` / `issueId` and a snapshot Issue for
 * the modal label — but **not** the status it will act on: the rollback
 * re-resolves the Issue from disk at confirm time, so a status that advanced
 * under the open modal (a not-actually-dead agent, or another edge) is honoured,
 * never overwritten. The orphan counterpart to a
 * {@link import("../review/reviewReader.js").ReviewPreview}, minus the
 * review-only context (eligibility, PRD body, feature branch): a rollback only
 * rewrites one status, it builds no prompt.
 */
export interface RedispatchPreview {
  /** The parent PRD's id, frozen so confirm re-resolves the same Issue. */
  readonly prdId: string;
  /** The Issue's id, frozen so confirm re-resolves the same Issue. */
  readonly issueId: string;
  /** The orphaned Issue snapshotted at preview-open time, for the modal label. */
  readonly issue: DispatchIssue;
}

/**
 * Build the production {@link Rollback} seam the App drives at the Issue level,
 * the recovery counterpart to the {@link import("../review/reviewer.js").createReviewer}
 * dispatcher/reviewer wiring. It resolves a (PRD id, Issue id) to the orphaned
 * Issue for the re-dispatch preview, and on confirm **re-resolves it from disk**
 * and rolls that Issue back onto its frontier via {@link rollBackOrphan} — no
 * spawn, no git, no prompt.
 *
 * The re-resolve at confirm is what makes the human a real safety check (ADR
 * 0009): the `orphaned` marker is computed at scan time and can be stale by
 * confirm, so acting on the *frozen* status would clobber an agent that merely
 * looked dead. Reading the current status at confirm, and rolling back only a
 * still-active Issue, turns "disk advanced under the modal" into a no-op rather
 * than a double-spawn.
 *
 * Both entry points are total, like the reviewer's: the root is
 * filesystem-watched and changes under the TUI, so `R` and confirm can race a
 * deletion. A vanished PRD/Issue resolves to `undefined` / `vanished`; the
 * status-writer is the shared {@link import("../issueFile.js").writeStatus}, not
 * a seam, exactly as the reviewer does — only the genuinely external edges are
 * injected, and a rollback has none.
 */
export function createRollback(root: string): Rollback {
  return {
    readRollback(prdId: string, issueId: string): RedispatchPreview | undefined {
      const target = readReviewTarget(join(root, prdId), issueId);
      if (!target) return undefined;
      return { prdId, issueId, issue: target.issue };
    },

    rollback(preview: RedispatchPreview): RollbackOutcome {
      // Re-resolve from disk: the frozen snapshot's status may be stale by now.
      const target = readReviewTarget(join(root, preview.prdId), preview.issueId);
      if (!target) return "vanished";
      return rollBackOrphan(target.issue, { writeStatus });
    },
  };
}
