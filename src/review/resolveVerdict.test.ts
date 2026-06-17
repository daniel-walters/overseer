import { describe, it, expect } from "vitest";
import { resolveVerdict, type ResolveVerdictDeps } from "./resolveVerdict.js";
import type { MergeInput, MergeResult } from "./mergeSeam.js";
import type { DispatchIssue } from "../dispatch/reader.js";

function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    title: overrides.title ?? "001-a.md",
    path: overrides.path ?? "/root/prd/001-a.md",
    status: "status" in overrides ? overrides.status : "in-review",
    blockedBy: overrides.blockedBy ?? [],
    repo: "repo" in overrides ? overrides.repo : "/repos/backend",
    worktree: "worktree" in overrides ? overrides.worktree : "/wt/blue-cat-fox",
    branch: "branch" in overrides ? overrides.branch : "blue-cat-fox",
    deviation: overrides.deviation,
    reviewVerdict: "reviewVerdict" in overrides ? overrides.reviewVerdict : "clean",
    body: overrides.body ?? "",
  };
}

/** Recording seams: no real git or fs. `merge` returns `merged` unless overridden. */
function deps(
  overrides: Partial<ResolveVerdictDeps> = {},
): ResolveVerdictDeps & {
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
    merge: (input): MergeResult => {
      merges.push(input);
      return { outcome: "merged" };
    },
    cleanUp: (input) => cleanups.push(input),
    writeStatus: (path, status) => writes.push([path, status]),
    ...overrides,
  };
}

const FEATURE = "auth-system";

describe("resolveVerdict", () => {
  it("merges the clean Issue then writes status: done", () => {
    const d = deps();
    resolveVerdict(issue({ path: "/root/prd/001-a.md" }), FEATURE, d);

    expect(d.merges).toEqual([
      {
        repo: "/repos/backend",
        worktree: "/wt/blue-cat-fox",
        branch: "blue-cat-fox",
        featureBranch: FEATURE,
      },
    ]);
    expect(d.writes).toEqual([["/root/prd/001-a.md", "done"]]);
  });

  it("cleans up the worktree after the durable done write, not before", () => {
    const order: string[] = [];
    const d = deps({
      merge: () => {
        order.push("merge");
        return { outcome: "merged" };
      },
      writeStatus: (_p, status) => order.push(`write:${status}`),
      cleanUp: () => order.push("cleanup"),
    });
    resolveVerdict(issue(), FEATURE, d);

    // `done` is the durable idempotency lock; cleanup is best-effort afterward.
    expect(order).toEqual(["merge", "write:done", "cleanup"]);
  });

  it("does not write done or clean up when the merge does not succeed", () => {
    // A non-merged outcome (conflict/transient handling deferred to 002/004) leaves
    // the Issue in-review with its verdict, to be retried on the next reconcile.
    const d = deps({
      merge: () => ({ outcome: "failure", error: "boom" }),
    });
    resolveVerdict(issue(), FEATURE, d);

    expect(d.writes).toEqual([]);
    expect(d.cleanups).toEqual([]);
  });

  it("does not merge an Issue carrying a deviation (deferred to a later slice)", () => {
    // A recorded deviation must route to human-review without merging; that fork
    // is deferred, so for now the decision simply leaves it untouched rather than
    // wrongly auto-merging it.
    const d = deps({ deviation: undefined });
    resolveVerdict(issue({ deviation: "took a shortcut" }), FEATURE, d);

    expect(d.merges).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("does nothing for an Issue missing the worktree/branch needed to merge", () => {
    const d = deps();
    resolveVerdict(issue({ worktree: undefined }), FEATURE, d);
    resolveVerdict(issue({ branch: undefined }), FEATURE, d);
    resolveVerdict(issue({ repo: undefined }), FEATURE, d);

    expect(d.merges).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("does not clean up or throw when the done write fails", () => {
    // The Issue file vanished from the watched root after the merge: the `done`
    // write ENOENTs. We must not clean up (the Issue is not done; merge --no-ff is
    // idempotent, so the next reconcile retries) and must not throw out.
    const d = deps({
      writeStatus: () => {
        throw new Error("ENOENT");
      },
    });
    expect(() => resolveVerdict(issue(), FEATURE, d)).not.toThrow();
    expect(d.cleanups).toEqual([]);
  });
});
