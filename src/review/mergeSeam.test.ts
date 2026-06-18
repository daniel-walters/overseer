import { describe, it, expect, vi } from "vitest";
import {
  mergeWorktree,
  cleanUpWorktree,
  type MergeSeam,
  type MergeInput,
} from "./mergeSeam.js";

/**
 * A scriptable stand-in for the real git merge seam, mirroring
 * `gitSetup.test.ts`'s `FakeGit`. Records every call and answers from in-memory
 * state so the clean-merge orchestration is asserted with no real git.
 */
class FakeMergeGit implements MergeSeam {
  /** Worktrees the fake treats as having uncommitted changes (dirty). */
  readonly dirty = new Set<string>();
  /** Repos whose `merge` should throw, simulating a conflict/transient failure. */
  readonly failMerge = new Set<string>();
  /** Repos whose `checkout` should throw. */
  readonly failCheckout = new Set<string>();
  /** Worktrees whose `removeWorktree` should throw. */
  readonly failRemove = new Set<string>();
  /**
   * Unmerged paths the fake reports per repo after a failed merge — non-empty ⇒
   * the failure was a real conflict, empty ⇒ a transient git error.
   */
  readonly conflicts = new Map<string, readonly string[]>();

  readonly isWorktreeClean = vi.fn(
    (worktree: string) => !this.dirty.has(worktree),
  );
  readonly checkout = vi.fn((repo: string) => {
    if (this.failCheckout.has(repo)) throw new Error(`checkout failed in ${repo}`);
  });
  readonly merge = vi.fn((repo: string) => {
    if (this.failMerge.has(repo)) throw new Error(`merge conflict in ${repo}`);
  });
  readonly conflictingPaths = vi.fn(
    (repo: string): readonly string[] => this.conflicts.get(repo) ?? [],
  );
  readonly abortMerge = vi.fn();
  readonly removeWorktree = vi.fn((_repo: string, worktree: string) => {
    if (this.failRemove.has(worktree)) {
      throw new Error(`worktree remove failed for ${worktree}`);
    }
  });
  readonly deleteBranch = vi.fn();
}

const input: MergeInput = {
  repo: "/repos/api",
  worktree: "/wt/blue-cat-fox",
  branch: "blue-cat-fox",
  featureBranch: "auth-system",
};

describe("mergeWorktree", () => {
  it("merges a clean worktree into the feature branch", () => {
    const git = new FakeMergeGit();

    const result = mergeWorktree(input, git);

    expect(result).toEqual({ outcome: "merged" });
    // Checked out the feature branch, then merged the recorded branch into it.
    expect(git.checkout).toHaveBeenCalledWith("/repos/api", "auth-system");
    expect(git.merge).toHaveBeenCalledWith("/repos/api", "blue-cat-fox");
  });

  it("checks the worktree is clean before checking out or merging", () => {
    const git = new FakeMergeGit();
    git.dirty.add("/wt/blue-cat-fox");

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("failure");
    // A dirty worktree is a precheck failure: nothing is checked out or merged.
    expect(git.checkout).not.toHaveBeenCalled();
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("verifies the worktree before touching the repo (clean check first)", () => {
    const order: string[] = [];
    const git = new FakeMergeGit();
    git.isWorktreeClean.mockImplementation(() => {
      order.push("clean-check");
      return true;
    });
    git.checkout.mockImplementation(() => order.push("checkout"));
    git.merge.mockImplementation(() => order.push("merge"));

    mergeWorktree(input, git);

    expect(order).toEqual(["clean-check", "checkout", "merge"]);
  });

  it("reports a merge failure rather than throwing", () => {
    const git = new FakeMergeGit();
    git.failMerge.add("/repos/api");

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.error).toMatch(/conflict/i);
    }
  });

  it("reports a checkout failure rather than throwing", () => {
    const git = new FakeMergeGit();
    git.failCheckout.add("/repos/api");

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("failure");
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("aborts the merge and reports a conflict when the merge leaves unmerged paths", () => {
    const git = new FakeMergeGit();
    git.failMerge.add("/repos/api");
    git.conflicts.set("/repos/api", ["src/a.ts", "src/b.ts"]);

    const result = mergeWorktree(input, git);

    // A real conflict is its own outcome, distinct from a transient `failure`, and
    // carries the conflicting paths so the caller can explain what conflicted.
    expect(result).toEqual({
      outcome: "conflict",
      files: ["src/a.ts", "src/b.ts"],
    });
    // Overseer never auto-resolves: it aborts the merge, leaving the feature
    // branch clean for a human to resolve.
    expect(git.abortMerge).toHaveBeenCalledWith("/repos/api");
  });

  it("reports a transient failure (not a conflict) when the merge leaves no unmerged paths", () => {
    const git = new FakeMergeGit();
    git.failMerge.add("/repos/api");
    // No unmerged paths recorded ⇒ the merge failed for some other (transient)
    // reason, so there is nothing to abort and the outcome is a plain failure.

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("failure");
    expect(git.abortMerge).not.toHaveBeenCalled();
  });

  it("treats a checkout failure as transient, never a conflict", () => {
    // A checkout that fails leaves no merge in progress, so there is nothing to
    // abort and no conflicting paths to report — it is a transient failure.
    const git = new FakeMergeGit();
    git.failCheckout.add("/repos/api");

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("failure");
    expect(git.abortMerge).not.toHaveBeenCalled();
  });

  it("still reports the conflict when the abort itself fails", () => {
    // A failed abort leaves the repo mid-merge, but escalating to human-review is
    // still the right call — the human sees the conflict note — so mergeWorktree
    // never throws and still returns the conflict outcome.
    const git = new FakeMergeGit();
    git.failMerge.add("/repos/api");
    git.conflicts.set("/repos/api", ["src/a.ts"]);
    git.abortMerge.mockImplementation(() => {
      throw new Error("abort failed");
    });

    const result = mergeWorktree(input, git);

    expect(result.outcome).toBe("conflict");
  });
});

describe("cleanUpWorktree", () => {
  it("removes the worktree and deletes the merged branch", () => {
    const git = new FakeMergeGit();

    cleanUpWorktree(input, git);

    expect(git.removeWorktree).toHaveBeenCalledWith("/repos/api", "/wt/blue-cat-fox");
    expect(git.deleteBranch).toHaveBeenCalledWith("/repos/api", "blue-cat-fox");
  });

  it("is best-effort: a failed worktree remove still deletes the branch and never throws", () => {
    // Cleanup runs after the durable `done` write, so a leaked worktree must not
    // throw out of the resolve step — and must not block the branch delete.
    const git = new FakeMergeGit();
    git.failRemove.add("/wt/blue-cat-fox");

    expect(() => cleanUpWorktree(input, git)).not.toThrow();
    expect(git.deleteBranch).toHaveBeenCalledWith("/repos/api", "blue-cat-fox");
  });

  it("does not throw when the branch delete fails", () => {
    const git = new FakeMergeGit();
    git.deleteBranch.mockImplementation(() => {
      throw new Error("branch -d failed");
    });

    expect(() => cleanUpWorktree(input, git)).not.toThrow();
  });
});
