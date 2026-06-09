import type { DispatchIssue } from "../dispatch/reader.js";
import {
  rollBackStatus,
  recordSpawnFailure,
  type FailureRecord,
} from "../dispatch/failureLog.js";
import { Status } from "../dispatch/status.js";

/**
 * The I/O seams a single review depends on, injected so the flip-then-spawn edge
 * is tested without touching the filesystem or spawning a real agent. Mirrors
 * the dispatch {@link import("../dispatch/dispatch.js").DispatchDeps}, minus the
 * git seam: review needs no branch setup (the implementor already created the
 * worktree; the reviewer merges into the existing feature branch itself).
 */
export interface ReviewDeps {
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /** Build the reviewer prompt for the Issue under review. */
  readonly buildPrompt: (issue: DispatchIssue) => string;
  /** Launch a reviewer agent in `repo` with the built `prompt`. Throws on failure. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
}

/**
 * Spawn a reviewer for one Issue. The review counterpart to
 * {@link import("../dispatch/dispatch.js").runDispatch}, acting on the single
 * deliberately-selected Issue rather than a whole PRD wave:
 *
 * 1. Flip the Issue `ready-for-review → in-review` *before* spawning. The status
 *    is the idempotency lock (ADR 0002): by the time the flip lands, the Issue
 *    is off the `ready-for-review` frontier, so a second `r` press (or the
 *    future reactor) can't double-spawn it.
 * 2. Spawn `claude --bg` in the Issue's repo with the reviewer prompt.
 * 3. If the spawn throws *after* the flip, roll the Issue back to
 *    `ready-for-review` (so the board never shows an in-review Issue with no
 *    reviewer) and append a record to the durable failure log.
 *
 * Total and best-effort throughout: it runs synchronously inside the Ink input
 * handler, which has no try/catch around it, so neither a vanished Issue file
 * (ENOENT on the flip or rollback) nor an unwritable failure log is allowed to
 * escape and crash the board.
 *
 * An Issue reaching the spawn with no `repo` recorded can't host an agent, so it
 * is left untouched — not flipped, not spawned. The eligibility classifier gates
 * this in the UI; the guard here keeps the edge itself total.
 */
export function runReview(issue: DispatchIssue, deps: ReviewDeps): void {
  const repo = issue.repo;
  if (repo === undefined || repo.trim() === "") return;

  try {
    deps.writeStatus(issue.path, Status.IN_REVIEW);
  } catch {
    return; // flip failed: nothing was started, so nothing to roll back or log
  }

  try {
    deps.spawn(repo, deps.buildPrompt(issue));
  } catch (err) {
    // Roll the flip back so the board never shows an in-review Issue with no
    // reviewer, and record the failure — both best-effort, sharing the dispatch
    // edge's helpers so the rollback contract and log schema can't drift.
    rollBackStatus(deps.writeStatus, issue.path, Status.READY_FOR_REVIEW);
    recordSpawnFailure(deps.logFailure, "reviewer", issue.id, repo, err);
  }
}
