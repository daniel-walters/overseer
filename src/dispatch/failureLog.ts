import { errorMessage } from "../errorMessage.js";
import type { AgentConfig } from "../agentConfig.js";

/**
 * Which spawn edge a failure came from. The dispatch, audit, and review edges
 * share one durable failure log; this discriminator lets an operator tell an
 * implementor launch failure apart from an auditor or reviewer launch failure for
 * the same Issue+repo. The auditor is the third spawn edge (ADR 0026), labelled
 * `audit` after the phase (matching the `audit` board lane), beside the
 * agent-named `implementor`/`reviewer`.
 */
export type SpawnEdgeKind = "implementor" | "audit" | "reviewer";

/**
 * Which edge a *suppressible* failure came from — the three spawn edges plus the
 * non-spawn **resolve** edge (ADR 0019 / 0026). A transient merge failure on the
 * resolve edge is suppressed and logged exactly as a spawn-launch failure is, so it
 * shares the failure log and the session-scoped failed-set keyed by
 * `(issueKey, edge)`. The `resolve` edge is kept distinct from
 * {@link SpawnEdgeKind} because resolving a verdict never spawns (the "exactly
 * three spawn edges" invariant holds — ADR 0026), but it widens the
 * failure-record/failed-set key so the four edge values never mask one another for
 * the same Issue.
 */
export type FailedEdgeKind = SpawnEdgeKind | "resolve";

/** A failure record appended to the durable dispatch log. */
export interface FailureRecord {
  /** The Issue filename whose agent failed to launch (or whose merge failed). */
  readonly issueId: string;
  /** The target repo the agent would have worked in (or the merge ran in). */
  readonly repo: string;
  /** The error message from the failed spawn (or merge). */
  readonly error: string;
  /**
   * Which edge failed — implementor (dispatch) / reviewer (review) spawn, or the
   * non-spawn `resolve` merge (ADR 0019).
   */
  readonly edge: FailedEdgeKind;
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

/**
 * Best-effort record of a freshly-spawned agent's handle against its Issue;
 * never throws. The handle is captured from `claude --bg`'s launch stdout and
 * written to the durable sidecar (ADR 0008); losing one — an unwritable sidecar
 * — must not crash the board or stop later candidates. The agent still ran; its
 * liveness simply degrades to "unknown" until a later orphan-reconciliation
 * feature picks it up.
 */
export function recordSpawnHandle(
  recordHandle: (issueKey: string, handle: string, reviewPass?: number) => void,
  issueKey: string,
  handle: string,
  reviewPass?: number,
): void {
  try {
    recordHandle(issueKey, handle, reviewPass);
  } catch {
    // The sidecar is unwritable (e.g. an unusable state dir). Losing one handle
    // leaves a live-but-unrecorded agent (unknown liveness), never a crash.
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
  /**
   * Launch the agent in `repo` at the configured {@link agent} runtime, returning
   * the handle parsed from the launch stdout (or `undefined` if none was printed);
   * throws on launch failure.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /**
   * The agent runtime (model + effort) this edge launches at, forwarded verbatim
   * to {@link spawn}. Optional: omitted ⇒ inherit the launcher's model/effort, so
   * an edge that does not configure a runtime spawns exactly as before.
   */
  readonly agent?: AgentConfig;
  /** Append a spawn-failure record to the durable log. */
  readonly logFailure: (record: FailureRecord) => void;
  /**
   * Record the launched agent's handle against `issueKey` (the Issue's path) in
   * the durable sidecar — the third, post-spawn step (ADR 0008). The optional
   * {@link reviewPass} below rides along to the same sidecar write.
   */
  readonly recordHandle: (
    issueKey: string,
    handle: string,
    reviewPass?: number,
  ) => void;
  /**
   * The AI-review pass number Overseer is driving for this spawn, recorded in the
   * sidecar beside the handle (ADR 0018). Set only on the review edge — a
   * dispatch spawn omits it, so its entry reads as no count. The agent never
   * supplies this; Overseer is the sole writer of the pass.
   */
  readonly reviewPass?: number;
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
 *
 * On a successful spawn there is a *third* step: record the handle the spawn
 * returned against the Issue in the durable sidecar (ADR 0008). It is last
 * because the handle does not exist until spawn returns; a crash in the
 * flip→spawn→record window leaves a live-but-unrecorded agent, deliberately left
 * to a later orphan-reconciliation feature. A spawn that returned no handle
 * (malformed launch line) records nothing — the agent ran, but its liveness will
 * read as unknown.
 *
 * Returns whether the agent actually launched: `false` if the pre-spawn flip
 * failed or the spawn threw (a failure already rolled back and logged), `true`
 * once the spawn returns. Callers that report a count to the user (the `d`
 * confirm notice) read this so they announce agents *launched*, never agents
 * *intended* — a launch that silently fails must not be reported as a success.
 */
export function spawnWithFlip(deps: SpawnWithFlip): boolean {
  try {
    deps.writeStatus(deps.issue.path, deps.active);
  } catch {
    return false; // flip failed: nothing was started, nothing to roll back or log
  }

  let handle: string | undefined;
  try {
    handle = deps.spawn(deps.repo, deps.buildPrompt(), deps.agent);
  } catch (err) {
    rollBackStatus(deps.writeStatus, deps.issue.path, deps.awaiting);
    recordSpawnFailure(deps.logFailure, deps.edge, deps.issue.id, deps.repo, err);
    return false;
  }

  // Third step: record the captured handle (and the review pass, when this is a
  // review spawn). Only when the spawn returned one — a missing handle leaves the
  // agent running but unrecorded (unknown liveness).
  if (handle !== undefined) {
    recordSpawnHandle(
      deps.recordHandle,
      deps.issue.path,
      handle,
      deps.reviewPass,
    );
  }
  return true;
}
