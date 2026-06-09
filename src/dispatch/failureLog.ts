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

/** The seams a single flip-then-spawn step depends on. */
export interface SpawnWithFlip {
  /** Which spawn edge this is — names the failure record. */
  readonly edge: SpawnEdgeKind;
  /** The Issue being acted on; its file path is flipped and its id is logged. */
  readonly issue: { readonly path: string; readonly id: string };
  /** The repo the agent is launched in and recorded against on failure. */
  readonly repo: string;
  /** The status to roll back to if the spawn fails (the awaiting status). */
  readonly awaiting: string;
  /** The status to flip to before spawning (the active status; the lock). */
  readonly active: string;
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /** Build the agent prompt, called only after the flip lands. */
  readonly buildPrompt: () => string;
  /** Launch the agent in `repo`; throws on failure. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable log. */
  readonly logFailure: (record: FailureRecord) => void;
}

/**
 * The shared spawn orchestration both edges run: flip the Issue from its
 * `awaiting` status to its `active` status *before* spawning (the status is the
 * idempotency lock, ADR 0002), then spawn `claude --bg`. A flip failure means
 * nothing was started — return with no rollback or log. A spawn failure *after*
 * the flip rolls the status back and records the failure.
 *
 * Dispatch (`ready-for-agent → in-progress`, implementor) and review
 * (`ready-for-review → in-review`, reviewer) differ only in the two statuses and
 * the edge label, so the structure lives here once rather than being copied per
 * edge. Total and best-effort throughout: it runs synchronously inside the Ink
 * input handler, which has no try/catch around it, so neither a vanished Issue
 * file nor an unwritable log may escape and crash the board.
 */
export function spawnWithFlip(deps: SpawnWithFlip): void {
  try {
    deps.writeStatus(deps.issue.path, deps.active);
  } catch {
    return; // flip failed: nothing was started, so nothing to roll back or log
  }

  try {
    deps.spawn(deps.repo, deps.buildPrompt());
  } catch (err) {
    rollBackStatus(deps.writeStatus, deps.issue.path, deps.awaiting);
    recordSpawnFailure(deps.logFailure, deps.edge, deps.issue.id, deps.repo, err);
  }
}
