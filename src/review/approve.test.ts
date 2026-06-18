import { describe, it, expect } from "vitest";
import { approve, type ApproveInput, type ApproveDeps } from "./approve.js";
import type { MergeInput, MergeResult, MergeSeam } from "./mergeSeam.js";

/** The recorded handoff fields + feature branch a human-review Approve merges. */
function input(overrides: Partial<ApproveInput> = {}): ApproveInput {
  return {
    repo: overrides.repo ?? "/repos/backend",
    worktree: overrides.worktree ?? "/wt/blue-cat-fox",
    branch: overrides.branch ?? "blue-cat-fox",
    path: overrides.path ?? "/root/prd/001-a.md",
    featureBranch: overrides.featureBranch ?? "auth-system",
  };
}

/**
 * Recording deps: a fake {@link MergeSeam} whose `mergeWorktree` returns a fixed
 * {@link MergeResult} (clean `merged` unless overridden) and a `writeStatus`
 * recorder — no real git or fs, mirroring `resolveVerdict.test.ts`. The handler is
 * a *second caller* of the same inner op (`mergeWorktree` + `cleanUpWorktree`), so
 * the seam is injected the same way and the assertions are which writes/cleanups
 * happen, never how the merge is internally sequenced.
 */
function deps(
  result: MergeResult = { outcome: "merged" },
  overrides: Partial<ApproveDeps> = {},
): ApproveDeps & {
  merges: MergeInput[];
  cleanups: MergeInput[];
  writes: [string, string][];
} {
  const merges: MergeInput[] = [];
  const cleanups: MergeInput[] = [];
  const writes: [string, string][] = [];
  return {
    merges,
    cleanups,
    writes,
    mergeWorktree: (mi: MergeInput): MergeResult => {
      merges.push(mi);
      return result;
    },
    cleanUpWorktree: (mi: MergeInput) => cleanups.push(mi),
    writeStatus: (path, status) => writes.push([path, status]),
    ...overrides,
  };
}

describe("approve", () => {
  it("merges the worktree branch into the feature branch on the recorded handoff", () => {
    const d = deps();
    approve(input(), d);

    expect(d.merges).toEqual([
      {
        repo: "/repos/backend",
        worktree: "/wt/blue-cat-fox",
        branch: "blue-cat-fox",
        featureBranch: "auth-system",
      },
    ]);
  });

  it("writes status: done and cleans up on a clean merge, returning merged", () => {
    const d = deps({ outcome: "merged" });
    const result = approve(input({ path: "/root/prd/001-a.md" }), d);

    expect(result).toEqual({ kind: "merged" });
    expect(d.writes).toEqual([["/root/prd/001-a.md", "done"]]);
    expect(d.cleanups).toEqual([
      {
        repo: "/repos/backend",
        worktree: "/wt/blue-cat-fox",
        branch: "blue-cat-fox",
        featureBranch: "auth-system",
      },
    ]);
  });

  it("writes the durable done lock before cleaning up, never the other way round", () => {
    const order: string[] = [];
    const d = deps(
      { outcome: "merged" },
      {
        writeStatus: (_p, status) => order.push(`write:${status}`),
        cleanUpWorktree: () => order.push("cleanup"),
      },
    );
    approve(input(), d);

    expect(order).toEqual(["write:done", "cleanup"]);
  });

  it("leaves the Issue untouched on a dirty worktree, returning dirty", () => {
    // A dirty worktree (the seam's preflight finds uncommitted changes) surfaces
    // as `failure` from the inner op. Approve must write nothing, clean up nothing,
    // and never move the card — the Issue stays human-review for the human to
    // commit their fix first (PRD user story 6).
    const d = deps({ outcome: "failure", error: "worktree dirty" });
    const result = approve(input(), d);

    expect(result).toEqual({ kind: "dirty" });
    expect(d.writes).toEqual([]);
    expect(d.cleanups).toEqual([]);
  });

  it("leaves the Issue untouched on a merge conflict, returning conflict", () => {
    // Overseer never auto-resolves a conflict — the inner op already aborted the
    // merge — so Approve writes no status, runs no cleanup, and leaves the card in
    // human-review for the human to resolve in the worktree first (PRD story 7).
    const d = deps({ outcome: "conflict", files: ["src/a.ts", "src/b.ts"] });
    const result = approve(input(), d);

    expect(result).toEqual({ kind: "conflict" });
    expect(d.writes).toEqual([]);
    expect(d.cleanups).toEqual([]);
  });

  it("does not throw when the done write fails, and does not clean up", () => {
    // The Issue file vanished after the merge: the `done` write ENOENTs. The merge
    // is idempotent (--no-ff), so re-pressing retries; cleanup must NOT run (the
    // Issue is not done), and nothing escapes to crash the board.
    const d = deps(
      { outcome: "merged" },
      {
        writeStatus: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(() => approve(input(), d)).not.toThrow();
    expect(d.cleanups).toEqual([]);
  });

  it("uses the injected mergeWorktree/cleanUpWorktree seam (a second caller of the inner op)", () => {
    // The handler depends only on the two inner-op functions + writeStatus — it is
    // the second caller of the same seam resolveVerdict wraps, never resolveVerdict
    // itself. A plain MergeSeam can drive the default-shaped deps.
    const seamCalls: string[] = [];
    const fakeSeam: MergeSeam = {
      isWorktreeClean: () => {
        seamCalls.push("isWorktreeClean");
        return true;
      },
      checkout: () => seamCalls.push("checkout"),
      merge: () => seamCalls.push("merge"),
      conflictingPaths: () => [],
      abortMerge: () => seamCalls.push("abortMerge"),
      removeWorktree: () => seamCalls.push("removeWorktree"),
      deleteBranch: () => seamCalls.push("deleteBranch"),
    };
    const writes: [string, string][] = [];
    const d: ApproveDeps = {
      mergeWorktree: (mi) =>
        // Drive the real inner op through the fake seam so this test pins that the
        // handler calls mergeWorktree, not a reimplemented merge.
        realMergeOver(mi, fakeSeam),
      cleanUpWorktree: (mi) => cleanUpOver(mi, fakeSeam),
      writeStatus: (p, s) => writes.push([p, s]),
    };
    const result = approve(input(), d);

    expect(result).toEqual({ kind: "merged" });
    expect(seamCalls).toContain("isWorktreeClean");
    expect(seamCalls).toContain("merge");
    expect(seamCalls).toContain("removeWorktree");
    expect(writes).toEqual([["/root/prd/001-a.md", "done"]]);
  });
});

// Local thin re-wraps so the seam-driving test above exercises the real inner op
// without importing it at module top (keeps the other tests on the pure recorder).
import { mergeWorktree, cleanUpWorktree } from "./mergeSeam.js";
function realMergeOver(mi: MergeInput, seam: MergeSeam): MergeResult {
  return mergeWorktree(mi, seam);
}
function cleanUpOver(mi: MergeInput, seam: MergeSeam): void {
  cleanUpWorktree(mi, seam);
}
