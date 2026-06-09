import { errorMessage } from "../errorMessage.js";

/**
 * Which spawn edge a failure came from. The dispatch and review edges share one
 * durable failure log; this discriminator lets an operator tell an implementor
 * launch failure apart from a reviewer launch failure for the same Issue+repo.
 */
export type SpawnEdgeKind = "implementor" | "reviewer";

/** A spawn-failure record appended to the durable dispatch log. */
export interface FailureRecord {
  /** The Issue filename whose agent failed to launch. */
  readonly issueId: string;
  /** The target repo the agent would have worked in. */
  readonly repo: string;
  /** The error message from the failed spawn. */
  readonly error: string;
  /** Which spawn edge failed — implementor (dispatch) vs reviewer (review). */
  readonly edge: SpawnEdgeKind;
}

/**
 * Best-effort rollback of a pre-spawn status flip; never throws. Shared by the
 * dispatch and review edges — both flip a status *before* spawning and must
 * undo it when the spawn fails, differing only in the status they roll back to
 * (`ready-for-agent` vs `ready-for-review`).
 *
 * The whole spawn edge runs synchronously inside the Ink input handler, which
 * has no try/catch around it, so a rollback write that ENOENTs (the Issue file
 * deleted in the race window after the flip) must not escape and crash the
 * board.
 */
export function rollBackStatus(
  writeStatus: (path: string, status: string) => void,
  path: string,
  status: string,
): void {
  try {
    writeStatus(path, status);
  } catch {
    // The Issue file vanished from the watched root after the flip. Nothing left
    // to roll back; the board reconciles on the next scan.
  }
}

/**
 * Best-effort append of a spawn failure to the durable log; never throws.
 * Shared by both spawn edges so the {@link FailureRecord} schema and the
 * swallow policy can never drift between dispatch and review.
 */
export function recordSpawnFailure(
  logFailure: (record: FailureRecord) => void,
  edge: SpawnEdgeKind,
  issueId: string,
  repo: string,
  err: unknown,
): void {
  try {
    logFailure({ issueId, repo, error: errorMessage(err), edge });
  } catch {
    // The durable log is unwritable (e.g. an unusable state dir). Losing one
    // failure record must not crash the board or stop later candidates.
  }
}
