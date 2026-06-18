import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import { spawnWithFlip, type FailureRecord } from "../dispatch/failureLog.js";
import { Status } from "../dispatch/status.js";
import { escalateNonConvergence } from "./escalate.js";
import type { ReviewConfig } from "./reviewConfig.js";
import type { AgentConfig } from "../agentConfig.js";

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
  /**
   * Launch a reviewer in `repo` with the built `prompt`, returning the handle
   * parsed from the launch stdout (or `undefined`). Throws on failure.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /**
   * The reviewer agent runtime (model + effort) this pass launches at. Optional:
   * omitted ⇒ inherit the launcher's model/effort, the pre-knob behaviour the
   * Reactor's own wiring tests rely on.
   */
  readonly agent?: AgentConfig;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /**
   * Record a launched reviewer's handle — and the {@link reviewPass} this spawn
   * drives — against its Issue key in the sidecar (ADR 0018).
   */
  readonly recordHandle: (
    issueKey: string,
    handle: string,
    reviewPass?: number,
  ) => void;
  /**
   * The AI-review pass this spawn drives, recorded in the sidecar at spawn time.
   * Overseer (the caller) computes it as `N+1` from the count it read off the
   * sidecar before deciding to spawn (ADR 0018) — the single source of truth for
   * both the loop's cap check and the card's `N/cap` marker. `runReview` only
   * records it; it never reads or increments the count.
   */
  readonly reviewPass: number;
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
  if (!hasValue(repo)) return;

  spawnWithFlip({
    edge: "reviewer",
    issue,
    repo,
    awaiting: Status.READY_FOR_REVIEW,
    active: Status.IN_REVIEW,
    writeStatus: deps.writeStatus,
    buildPrompt: () => deps.buildPrompt(issue),
    spawn: deps.spawn,
    agent: deps.agent,
    logFailure: deps.logFailure,
    recordHandle: deps.recordHandle,
    reviewPass: deps.reviewPass,
  });
}

/** The seams {@link driveReviewPass} needs beyond a single {@link runReview}. */
export interface DriveReviewPassDeps extends Omit<ReviewDeps, "reviewPass"> {
  /**
   * Read the AI-review pass already recorded for this Issue, or `undefined` when
   * none is (a fresh `ready-for-review` Issue ⇒ the first pass). Overseer's
   * sidecar is the single source of truth (ADR 0018).
   */
  readonly readReviewPass: (issueKey: string) => number | undefined;
  /** The resolved review knobs; only the `cap` is read here. */
  readonly review: ReviewConfig;
}

/**
 * Drive **one** AI-review pass for an Issue under the Reactor-owned loop (ADR
 * 0018), the single decision both the automated reconcile and the manual `r`
 * keybind share so a hand-driven loop steps through the count identically to the
 * automated one:
 *
 * 1. Read the pass count `N` already recorded for the Issue (absent ⇒ 0, the
 *    first pass).
 * 2. **At the cap** (`N ≥ review.cap`): the loop ran `cap` passes without
 *    converging. Escalate to `human-review` with `non-convergence` and spawn
 *    nothing — the cap is Overseer-enforced from the count it wrote, not an agent
 *    counting in its own head.
 * 3. **Below the cap**: spawn pass `N+1` through {@link runReview} (which flips
 *    `ready-for-review → in-review` first — the idempotency lock — then records
 *    `N+1` in the sidecar at spawn time).
 *
 * Total: {@link runReview} and {@link escalateNonConvergence} are both
 * best-effort and never throw, so this is safe inside both the watcher callback
 * and the Ink input handler.
 */
export function driveReviewPass(
  issue: DispatchIssue,
  deps: DriveReviewPassDeps,
): void {
  const completed = deps.readReviewPass(issue.path) ?? 0;
  if (completed >= deps.review.cap) {
    escalateNonConvergence(issue.path, completed, deps.review.cap);
    return;
  }
  runReview(issue, { ...deps, reviewPass: completed + 1 });
}
