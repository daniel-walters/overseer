import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";
import type { FailureRecord } from "../dispatch/failureLog.js";
import type { MergeInput, MergeResult } from "./mergeSeam.js";

/**
 * The seams the resolve-verdict decision depends on, injected so the review-edge
 * resolve is tested without touching git or the filesystem. Mirrors
 * {@link import("./review.js").ReviewDeps} for the spawn edge — it never spawns
 * (resolving a verdict is not a spawn, ADR 0019), but it both escalates to
 * `human-review` (the deviation/conflict forks) and logs a transient merge
 * failure exactly as a spawn-launch failure is logged, so it carries the same
 * {@link FailureRecord} sink the spawn edges use.
 */
export interface ResolveVerdictDeps {
  /** Run the clean merge of the worktree branch into the feature branch. */
  readonly merge: (input: MergeInput) => MergeResult;
  /** Tear down the merged worktree + branch (best-effort, after the done write). */
  readonly cleanUp: (input: MergeInput) => void;
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /**
   * Escalate the Issue to `human-review`, recording the reason and a free-text
   * note alongside the status — the terminal write for both the deviation fork
   * (reason `deviation`) and the conflict fork (reason `conflict`). Mirrors
   * {@link import("../issueFile.js").writeHumanReview}: the Reactor injects that
   * real fs writer, the decision's own tests a recorder.
   */
  readonly writeHumanReview: (
    path: string,
    reason: string,
    note: string,
  ) => void;
  /**
   * Append a failure record on a transient (non-conflict) merge failure (ADR
   * 0019), keyed by the `resolve` edge. The Reactor wraps this with
   * {@link import("../reactor/failedSet.js").recordingLogFailure} so the same
   * record also lands in the session failed-set — the verdict frontier subtracts
   * it, so a held merge does not re-attempt (and re-block the UI) this session;
   * reopening the board builds a fresh set and retries.
   */
  readonly logFailure: (record: FailureRecord) => void;
}

/**
 * Resolve a single `in-review` Issue carrying `review_verdict: clean` (ADR 0019)
 * — the review-edge twin of {@link import("./review.js").driveReviewPass}. Where
 * `driveReviewPass` decides whether to *spawn* the next pass, this decides how to
 * *finish* a pass that reported clean: Overseer, not the agent, owns the merge and
 * the terminal status write.
 *
 * The caller (the Reactor's resolve sweep) has already gated this on the verdict:
 * the Issue is `in-review` with `review_verdict: clean`. The decision forks on the
 * auditor's `deviation` field, then runs the merge:
 *
 * 1. A recorded `deviation` forecloses the clean auto-merge (a human owns every
 *    deviation). Overseer reads the auditor's field itself and routes the
 *    Issue to `human-review` with reason `deviation`, folding the auditor's
 *    note into the `human_review_note` so the human reads one coherent reason —
 *    no merge. This is why the reviewer prompt no longer mentions deviations: the
 *    agent writes `review_verdict: clean` regardless, and Overseer owns the fork.
 *    Checked before the merge handoff guard because routing a deviation needs no
 *    worktree/branch — it never merges. The auditor's raw `deviation` field is
 *    left untouched (the dispatch reader's audit trail).
 * 2. Guard that the merge handoff is present — a verdict-bearing Issue should
 *    carry the implementor's `repo`, `worktree`, and `branch`, but a hand-edited
 *    one may not. Without them there is nothing to merge, so leave it untouched.
 * 3. Run the merge and fork on its outcome:
 *    - `merged` → write `status: done` — the durable idempotency lock that removes
 *      the Issue from the verdict frontier (as flip-before-spawn does for spawns) —
 *      then clean up the worktree.
 *    - `conflict` → `writeHumanReview(conflict)`. Overseer never auto-resolves a
 *      conflict (the merge seam already aborted it); it escalates to the human
 *      queue with a note naming what conflicted. No `done`, no retry, no cleanup —
 *      the worktree survives for the human to resolve.
 *    - transient `failure` (a dirty worktree, a disk/git hiccup) → **suppress**
 *      rather than escalate: leave the Issue `in-review` with its still-valid
 *      verdict (nothing to roll back; only the merge needs retrying) and append a
 *      `resolve`-edge failure record. The wrapping recorder lands that in the
 *      session failed-set, so the verdict frontier subtracts it and it does not
 *      re-attempt this session; reopening the board retries it. A transient
 *      failure is **never** routed to `human-review` (that queue is for work
 *      needing human judgment, not environment hiccups — the same invariant that
 *      keeps spawn failures out of it) and never written to `done`.
 *
 * Total: it runs synchronously inside the Reactor's reconcile (the watcher
 * callback), which has no try/catch around it, so a vanished Issue file (ENOENT
 * on the `done` or `human-review` write) is swallowed — the merge is idempotent
 * (`--no-ff`), so the next reconcile retries — and nothing escapes to crash the
 * board.
 */
export function resolveVerdict(
  issue: DispatchIssue,
  featureBranch: string,
  deps: ResolveVerdictDeps,
): void {
  const { repo, worktree, branch, path, deviation } = issue;

  // A deviation defers the merge to a human (ADR 0019). It never merges, so it is
  // resolved before the merge-handoff guard — the worktree/branch are irrelevant
  // to a human-review write.
  if (hasValue(deviation)) {
    try {
      deps.writeHumanReview(path, "deviation", deviationNote(deviation));
    } catch {
      // The Issue file vanished between the sweep and this write; the next
      // reconcile re-evaluates it. Nothing escapes the watcher callback.
    }
    return;
  }

  if (!hasValue(repo) || !hasValue(worktree) || !hasValue(branch)) return;

  const input: MergeInput = { repo, worktree, branch, featureBranch };
  const result = deps.merge(input);

  if (result.outcome === "conflict") {
    try {
      deps.writeHumanReview(path, "conflict", conflictNote(input, result.files));
    } catch {
      // The Issue file vanished before the escalation write. Nothing to do; the
      // next reconcile re-evaluates it. Never throw out of the watcher callback.
    }
    return; // a conflict is a real outcome: no done, no retry, no cleanup
  }
  if (result.outcome !== "merged") {
    // A transient (non-conflict) merge failure: suppress and log, leaving the Issue
    // in-review with its verdict (there is nothing to roll back). Best-effort — the
    // log being unwritable must not escape the watcher callback; the Issue is left
    // for the next reconcile / board reopen to retry regardless.
    try {
      deps.logFailure({
        issueId: issue.id,
        repo,
        error: result.error,
        edge: "resolve",
      });
    } catch {
      // Losing one failure record never crashes the board or escalates the Issue.
    }
    return;
  }

  try {
    deps.writeStatus(path, Status.DONE);
  } catch {
    // The Issue file vanished after the merge. The merge already landed and
    // `--no-ff` is idempotent, so the next reconcile re-runs and re-writes `done`;
    // do NOT clean up (the Issue is not done yet — its worktree must survive).
    return;
  }
  deps.cleanUp(input); // best-effort, after the durable `done` lock
}

/**
 * The `human_review_note` for the deviation fork: fold the auditor's recorded
 * deviation into one coherent reason the human can read off the card without
 * opening the raw field, matching the prose {@link
 * import("./escalate.js").escalateNonConvergence} records for `non-convergence`.
 */
function deviationNote(deviation: string): string {
  return (
    `The auditor recorded a deviation from the planned approach: ` +
    `"${deviation}". The AI review passed clean, but a deviation needs a human ` +
    `to confirm before the merge. Review the change against the Issue, then run ` +
    `the merge skill.`
  );
}

/**
 * The `human_review_note` for a conflict escalation: which branches couldn't
 * merge, the unmerged files (the "what conflicted"), and the next human step —
 * the same self-explanatory prose `escalateNonConvergence` writes for its reason,
 * so a human reading the card knows why it escalated without opening anything.
 */
function conflictNote(input: MergeInput, files: readonly string[]): string {
  const where =
    files.length > 0 ? ` Conflicting files: ${files.join(", ")}.` : "";
  return (
    `Merging ${input.branch} into ${input.featureBranch} hit a conflict, ` +
    `so Overseer aborted the merge (it never auto-resolves).${where} ` +
    `Resolve the conflict by hand, then run the merge skill.`
  );
}
