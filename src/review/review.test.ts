import { describe, it, expect } from "vitest";
import { runReview, type ReviewDeps } from "./review.js";
import type { DispatchIssue } from "../dispatch/reader.js";

function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    title: overrides.title ?? (overrides.id ?? "001-a.md"),
    path: overrides.path ?? `/root/prd/${overrides.id ?? "001-a.md"}`,
    status: "status" in overrides ? overrides.status : "ready-for-review",
    blockedBy: overrides.blockedBy ?? [],
    repo: "repo" in overrides ? overrides.repo : "/repos/backend",
    worktree: "worktree" in overrides ? overrides.worktree : "/wt/blue-cat-fox",
    branch: "branch" in overrides ? overrides.branch : "blue-cat-fox",
    deviation: overrides.deviation,
    reviewVerdict: overrides.reviewVerdict,
    body: overrides.body ?? "",
  };
}

/** Recording seams: no real fs, git, or process. */
function deps(
  overrides: Partial<ReviewDeps> = {},
): ReviewDeps & {
  writes: [string, string][];
  spawns: { repo: string; prompt: string }[];
  failures: { issueId: string; repo: string; error: string; edge: string }[];
  handles: { issueKey: string; handle: string; reviewPass?: number }[];
} {
  const writes: [string, string][] = [];
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: { issueId: string; repo: string; error: string; edge: string }[] = [];
  const handles: { issueKey: string; handle: string; reviewPass?: number }[] = [];
  return {
    writes,
    spawns,
    failures,
    handles,
    writeStatus: (path, status) => writes.push([path, status]),
    buildPrompt: (i) => `review-prompt-for-${i.id}`,
    spawn: (repo, prompt) => {
      spawns.push({ repo, prompt });
      return `handle-${repo}`;
    },
    logFailure: (r) => failures.push(r),
    recordHandle: (issueKey, handle, reviewPass) =>
      handles.push({ issueKey, handle, reviewPass }),
    reviewPass: 1,
    ...overrides,
  };
}

describe("runReview", () => {
  it("flips the Issue to in-review, then spawns the reviewer in its repo", () => {
    const d = deps();
    runReview(issue({ id: "002-b.md", path: "/root/prd/002-b.md", repo: "/repos/api" }), d);

    expect(d.writes).toEqual([["/root/prd/002-b.md", "in-review"]]);
    expect(d.spawns).toEqual([
      { repo: "/repos/api", prompt: "review-prompt-for-002-b.md" },
    ]);
  });

  it("flips the status before spawning", () => {
    const order: string[] = [];
    runReview(
      issue(),
      deps({
        writeStatus: (_p, status) => order.push(`write:${status}`),
        spawn: () => {
          order.push("spawn");
          return "h1";
        },
      }),
    );
    expect(order).toEqual(["write:in-review", "spawn"]);
  });

  it("records the reviewer's handle and the driven pass against the Issue after spawning", () => {
    const d = deps({ reviewPass: 2 });
    runReview(issue({ id: "002-b.md", path: "/root/prd/002-b.md", repo: "/repos/api" }), d);

    // The pass Overseer told it to drive is recorded alongside the handle (ADR
    // 0018) — the sidecar carries both for the liveness join and the `N/cap` marker.
    expect(d.handles).toEqual([
      { issueKey: "/root/prd/002-b.md", handle: "handle-/repos/api", reviewPass: 2 },
    ]);
  });

  it("does not record a handle when the reviewer spawn throws", () => {
    const d = deps({
      spawn: () => {
        throw new Error("claude not found");
      },
    });
    runReview(issue(), d);

    expect(d.handles).toEqual([]);
  });

  it("rolls the Issue back to ready-for-review when the spawn throws", () => {
    const d = deps({
      spawn: () => {
        throw new Error("claude not found");
      },
    });
    runReview(issue({ path: "/root/prd/001-a.md" }), d);

    expect(d.writes).toEqual([
      ["/root/prd/001-a.md", "in-review"],
      ["/root/prd/001-a.md", "ready-for-review"],
    ]);
    expect(d.spawns).toEqual([]);
  });

  it("appends a failure record (issue, repo, error) when the spawn throws", () => {
    const d = deps({
      spawn: () => {
        throw new Error("claude not found");
      },
    });
    runReview(issue({ id: "001-a.md", repo: "/repos/api" }), d);

    expect(d.failures).toEqual([
      { issueId: "001-a.md", repo: "/repos/api", error: "claude not found", edge: "reviewer" },
    ]);
  });

  it("does not spawn, roll back, or log when the flip itself throws", () => {
    // The Issue file vanished from the watched root after the preview: the flip
    // ENOENTs. Nothing was started, so there is nothing to roll back or log.
    const d = deps({
      writeStatus: () => {
        throw new Error("ENOENT");
      },
    });
    expect(() => runReview(issue(), d)).not.toThrow();
    expect(d.spawns).toEqual([]);
    expect(d.failures).toEqual([]);
  });

  it("does not flip or spawn an Issue with no repo to spawn in", () => {
    const d = deps();
    runReview(issue({ repo: undefined }), d);
    expect(d.writes).toEqual([]);
    expect(d.spawns).toEqual([]);
  });

  it("does not let a throwing rollback escape", () => {
    // The whole edge runs inside the Ink input handler with no try/catch; a
    // rollback write that ENOENTs (file deleted in the race window) must not
    // crash the board.
    const d = deps({
      writeStatus: (_p, status) => {
        if (status === "ready-for-review") throw new Error("ENOENT on rollback");
      },
      spawn: () => {
        throw new Error("boom");
      },
    });
    expect(() => runReview(issue(), d)).not.toThrow();
    // The failure was still logged despite the failed rollback.
    expect(d.failures).toHaveLength(1);
  });

  it("does not let a throwing failure-log escape", () => {
    const d = deps({
      spawn: () => {
        throw new Error("boom");
      },
      logFailure: () => {
        throw new Error("EACCES on log");
      },
    });
    expect(() => runReview(issue({ path: "/root/prd/001-a.md" }), d)).not.toThrow();
    // The rollback still happened despite the unwritable log.
    expect(d.writes).toContainEqual(["/root/prd/001-a.md", "ready-for-review"]);
  });
});
