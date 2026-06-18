import { execFileSync } from "node:child_process";
import { errorMessage } from "../errorMessage.js";

/**
 * The git half of the **resolve-verdict** edge (ADR 0019): the in-process merge
 * Overseer runs to finish a clean-reviewed Issue, taking the place of the merge
 * the reviewer agent used to run itself. It mirrors the dispatcher's `GitSeam`
 * (`gitSetup.ts`): every git action is one narrow injected method, so the
 * orchestration is unit-tested with no real git and the default seam shells out.
 *
 * This slice covers the **clean** path plus **conflict** detection — verify the
 * worktree is clean → check out the feature branch → `merge --no-ff` the worktree
 * branch → on a real conflict `merge --abort` and report it, else remove the
 * worktree + delete the branch. Transient-failure suppression (treating a
 * non-conflict merge error like a spawn-launch failure) is deferred to a later
 * slice; until then a transient error surfaces here as a generic `failure`.
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
   * merge conflict or any other git failure; the caller then consults
   * {@link conflictingPaths} to tell the two apart.
   */
  merge(repo: string, branch: string): void;
  /**
   * The repo's unmerged paths after a failed {@link merge} — the signal that the
   * failure was a real *conflict* (a non-empty list) rather than a transient git
   * error (an empty list). A checkout/transient failure leaves no merge in
   * progress, so this is empty; a conflict leaves the conflicting paths unmerged.
   * Doubles as the "what conflicted" detail folded into the human-review note.
   */
  conflictingPaths(repo: string): readonly string[];
  /**
   * Abort the in-progress (conflicted) merge in `repo` (`git merge --abort`),
   * restoring the feature branch to its pre-merge state. Overseer never
   * auto-resolves a conflict — it aborts and escalates to `human-review` — so this
   * runs only on the conflict path, after {@link conflictingPaths} confirms one.
   */
  abortMerge(repo: string): void;
  /** Remove the worktree at `worktree` from `repo` (post-merge cleanup). */
  removeWorktree(repo: string, worktree: string): void;
  /** Delete the local `branch` in `repo` (post-merge cleanup). */
  deleteBranch(repo: string, branch: string): void;
}

/**
 * The outcome of attempting the merge. Three distinct cases the caller maps to
 * three distinct terminal actions (ADR 0019): `merged` (write `done`), `conflict`
 * (a real merge conflict, aborted — escalate to `human-review` with reason
 * `conflict`), and `failure` (a transient git error — suppress and retry, never
 * `human-review`). A conflict carries the unmerged `files` so the caller can
 * explain *what* conflicted in the human-review note.
 */
export type MergeResult =
  | { readonly outcome: "merged" }
  | { readonly outcome: "conflict"; readonly files: readonly string[] }
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
 * Run the merge: verify the worktree is clean, check out the feature branch, and
 * `merge --no-ff` the worktree branch into it. Returns `merged` on success;
 * `conflict` (with the unmerged files) when the merge left unmerged paths — the
 * merge is aborted first, so the feature branch is left clean; or `failure` (with
 * the git error) on a dirty worktree, a checkout failure, or a transient merge
 * error that left no conflict to abort. Never throws — the caller (the
 * resolve-verdict decision, run inside the watcher callback) maps the result to a
 * terminal status and must not see an exception escape.
 *
 * Conflict vs transient is decided by {@link MergeSeam.conflictingPaths}: a real
 * conflict leaves unmerged paths, a transient error (or a checkout that never
 * started a merge) leaves none. The abort is best-effort — if it throws, the
 * conflict is still reported (escalating to `human-review` is the right call
 * regardless), so a failed abort never turns into a swallowed exception.
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
    const files = git.conflictingPaths(input.repo);
    if (files.length === 0) {
      // No unmerged paths ⇒ the merge never conflicted (a transient git error, or
      // a checkout that failed before any merge started). Nothing to abort.
      return { outcome: "failure", error: errorMessage(err) };
    }
    try {
      git.abortMerge(input.repo);
    } catch {
      // A failed abort leaves the repo mid-merge — a real mess, but escalating to
      // human-review (with the conflict note) is still the right outcome, and the
      // human will see the conflicted state. Never let it throw out of the merge.
    }
    return { outcome: "conflict", files };
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

  conflictingPaths(repo: string): readonly string[] {
    // `diff --diff-filter=U --name-only` lists exactly the unmerged (conflicted)
    // paths; non-empty ⇒ the failed merge was a real conflict. A git failure
    // (repo vanished, not mid-merge) can't confirm a conflict, so it reads as
    // none — fail-safe: an unconfirmable conflict is treated as a transient
    // failure (retried) rather than wrongly escalated to human-review.
    try {
      const out = execFileSync(
        "git",
        ["-C", repo, "diff", "--diff-filter=U", "--name-only"],
        { encoding: "utf8" },
      );
      return out.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  },

  abortMerge(repo: string): void {
    execFileSync("git", ["-C", repo, "merge", "--abort"], { stdio: "ignore" });
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
