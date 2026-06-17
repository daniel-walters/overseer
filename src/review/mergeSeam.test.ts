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

  readonly isWorktreeClean = vi.fn(
    (worktree: string) => !this.dirty.has(worktree),
  );
  readonly checkout = vi.fn((repo: string) => {
    if (this.failCheckout.has(repo)) throw new Error(`checkout failed in ${repo}`);
  });
  readonly merge = vi.fn((repo: string) => {
    if (this.failMerge.has(repo)) throw new Error(`merge conflict in ${repo}`);
  });
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
