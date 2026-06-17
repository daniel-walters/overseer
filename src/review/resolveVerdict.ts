import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";
import type { MergeInput, MergeResult } from "./mergeSeam.js";

/**
 * The seams the resolve-verdict decision depends on, injected so the review-edge
 * resolve is tested without touching git or the filesystem. Mirrors
 * {@link import("./review.js").ReviewDeps} for the spawn edge — minus spawn/log,
 * which a resolve never does (resolving a verdict is not a spawn, ADR 0019).
 */
export interface ResolveVerdictDeps {
  /** Run the clean merge of the worktree branch into the feature branch. */
  readonly merge: (input: MergeInput) => MergeResult;
  /** Tear down the merged worktree + branch (best-effort, after the done write). */
  readonly cleanUp: (input: MergeInput) => void;
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
}

/**
 * Resolve a single `in-review` Issue carrying `review_verdict: clean` (ADR 0019)
 * — the review-edge twin of {@link import("./review.js").driveReviewPass}. Where
 * `driveReviewPass` decides whether to *spawn* the next pass, this decides how to
 * *finish* a pass that reported clean: Overseer, not the agent, owns the merge and
 * the terminal status write.
 *
 * The caller (the Reactor's resolve sweep) has already gated this on the verdict:
 * the Issue is `in-review` with `review_verdict: clean`. This slice handles the
 * **clean merge → done** path only:
 *
 * 1. Guard that the merge handoff is present — a verdict-bearing Issue should
 *    carry the implementor's `repo`, `worktree`, and `branch`, but a hand-edited
 *    one may not. Without them there is nothing to merge, so leave it untouched.
 * 2. A recorded `deviation` forecloses the clean auto-merge (a human owns every
 *    deviation). Routing it to `human-review` is a later slice; until then the
 *    decision simply leaves it rather than wrongly merging it.
 * 3. Run the merge. On `merged`, write `status: done` — the durable idempotency
 *    lock that removes the Issue from the verdict frontier (as flip-before-spawn
 *    does for spawns) — then clean up the worktree. A non-`merged` outcome
 *    (conflict / transient failure, handled in later slices) leaves the Issue
 *    `in-review` with its verdict, to be retried on the next reconcile.
 *
 * Total: it runs synchronously inside the Reactor's reconcile (the watcher
 * callback), which has no try/catch around it, so a vanished Issue file (ENOENT
 * on the `done` write) is swallowed — the merge is idempotent (`--no-ff`), so the
 * next reconcile retries — and nothing escapes to crash the board.
 */
export function resolveVerdict(
  issue: DispatchIssue,
  featureBranch: string,
  deps: ResolveVerdictDeps,
): void {
  const { repo, worktree, branch, path } = issue;
  if (!hasValue(repo) || !hasValue(worktree) || !hasValue(branch)) return;
  // A deviation routes to human-review without merging; that fork is deferred, so
  // for now leave the Issue rather than auto-merge over a recorded deviation.
  if (hasValue(issue.deviation)) return;

  const input: MergeInput = { repo, worktree, branch, featureBranch };
  const result = deps.merge(input);
  if (result.outcome !== "merged") return; // conflict/transient deferred to later slices

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
