import { execFileSync } from "node:child_process";
import { errorMessage } from "../errorMessage.js";

/**
 * The git half of the **resolve-verdict** edge (ADR 0019): the in-process merge
 * Overseer runs to finish a clean-reviewed Issue, taking the place of the merge
 * the reviewer agent used to run itself. It mirrors the dispatcher's `GitSeam`
 * (`gitSetup.ts`): every git action is one narrow injected method, so the
 * orchestration is unit-tested with no real git and the default seam shells out.
 *
 * This slice covers the **clean** path only — verify the worktree is clean →
 * check out the feature branch → `merge --no-ff` the worktree branch → remove the
 * worktree + delete the branch. Conflict detection (aborting the merge and
 * escalating to `human-review`) and transient-failure suppression are deferred to
 * later slices; the {@link MergeResult} union and this seam leave room for them
 * (a `conflict` outcome and an `abortMerge` method are the natural extensions).
 */

/**
 * The injectable git seam. Each method is a single, narrow git action so a test
 * fake answers from in-memory state and the real implementation shells out.
 */
export interface MergeSeam {
  /**
   * Whether the worktree at `worktree` has no uncommitted changes. The clean
   * path refuses to merge a dirty worktree — uncommitted work would be lost or
   * silently merged — so this is the precheck before anything is checked out.
   */
  isWorktreeClean(worktree: string): boolean;
  /** Check out `branch` (the feature branch — the merge target) in `repo`. */
  checkout(repo: string, branch: string): void;
  /**
   * Merge `branch` into the repo's currently checked-out branch with `--no-ff`.
   * `--no-ff` is naturally idempotent (re-merging an already-merged branch is a
   * no-op), so a board crash mid-merge recovers by simply re-running. Throws on a
   * merge conflict or any other git failure.
   */
  merge(repo: string, branch: string): void;
  /** Remove the worktree at `worktree` from `repo` (post-merge cleanup). */
  removeWorktree(repo: string, worktree: string): void;
  /** Delete the local `branch` in `repo` (post-merge cleanup). */
  deleteBranch(repo: string, branch: string): void;
}

/**
 * The outcome of attempting the clean merge. `merged` is the only success; every
 * other case is a `failure` carrying the git error. Conflict detection is a later
 * slice — until then a conflict surfaces here as a generic `failure` — so this
 * union is deliberately open to a third `conflict` outcome without breaking
 * callers that already handle `merged` / `failure`.
 */
export type MergeResult =
  | { readonly outcome: "merged" }
  | { readonly outcome: "failure"; readonly error: string };

/** The handoff the merge reads off the resolving Issue plus its PRD feature branch. */
export interface MergeInput {
  /** The repo every git command runs in (`git -C repo`). */
  readonly repo: string;
  /** The implementor's recorded worktree, verified clean before the merge. */
  readonly worktree: string;
  /** The implementor's recorded branch, merged into the feature branch. */
  readonly branch: string;
  /** The PRD feature branch the worktree branch merges into. */
  readonly featureBranch: string;
}

/**
 * Run the clean merge: verify the worktree is clean, check out the feature
 * branch, and `merge --no-ff` the worktree branch into it. Returns `merged` on
 * success, or `failure` (with the git error) on a dirty worktree, a checkout
 * failure, or a merge failure. Never throws — the caller (the resolve-verdict
 * decision, run inside the watcher callback) maps the result to a terminal status
 * and must not see an exception escape.
 *
 * Cleanup (removing the worktree + deleting the branch) is deliberately *not*
 * here: it runs in {@link cleanUpWorktree} *after* the caller has written the
 * durable `done` status (ADR 0019), so a crash between merge and cleanup leaves a
 * leaked worktree, not a wedged Issue.
 */
export function mergeWorktree(input: MergeInput, git: MergeSeam): MergeResult {
  if (!git.isWorktreeClean(input.worktree)) {
    return {
      outcome: "failure",
      error: `worktree ${input.worktree} has uncommitted changes`,
    };
  }
  try {
    git.checkout(input.repo, input.featureBranch);
    git.merge(input.repo, input.branch);
  } catch (err) {
    return { outcome: "failure", error: errorMessage(err) };
  }
  return { outcome: "merged" };
}

/**
 * Tear down a merged Issue's worktree: remove the worktree, then delete the
 * branch. Best-effort and total — it runs *after* the durable `done` write, so a
 * failed removal leaks a worktree but must never throw out of the resolve step or
 * block the branch delete. Each step is swallowed independently so one failing
 * does not skip the other.
 */
export function cleanUpWorktree(input: MergeInput, git: MergeSeam): void {
  try {
    git.removeWorktree(input.repo, input.worktree);
  } catch {
    // A leaked worktree is a cosmetic leak, not a correctness bug: the merge
    // already landed and `done` is written. Fall through to the branch delete.
  }
  try {
    git.deleteBranch(input.repo, input.branch);
  } catch {
    // Likewise — a leaked branch never wedges the (already-`done`) Issue.
  }
}

/**
 * The real git seam used in production: shells out to `git` with `-C <repo>`,
 * mirroring `gitSetup.ts`'s `realGitSeam`. Construction-free — a plain object so
 * callers can pass it straight to {@link mergeWorktree} / {@link cleanUpWorktree}.
 */
export const realMergeSeam: MergeSeam = {
  isWorktreeClean(worktree: string): boolean {
    // `status --porcelain` prints one line per change; empty output ⇒ clean. A
    // git failure (worktree vanished, not a repo) can't confirm clean, so it
    // reads as *not* clean — fail-safe: never merge a worktree we can't vouch for.
    try {
      const out = execFileSync(
        "git",
        ["-C", worktree, "status", "--porcelain"],
        { encoding: "utf8" },
      );
      return out.trim() === "";
    } catch {
      return false;
    }
  },

  checkout(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "checkout", branch], { stdio: "ignore" });
  },

  merge(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "merge", "--no-ff", branch], {
      stdio: "ignore",
    });
  },

  removeWorktree(repo: string, worktree: string): void {
    execFileSync("git", ["-C", repo, "worktree", "remove", worktree], {
      stdio: "ignore",
    });
  },

  deleteBranch(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "branch", "-d", branch], {
      stdio: "ignore",
    });
  },
};
