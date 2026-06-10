import { describe, it, expect } from "vitest";
import { sweepFrontier, type SweptPrd } from "./sweep.js";
import type { DispatchView, DispatchIssue } from "../dispatch/reader.js";

/** A DispatchIssue with sensible defaults, overridable per field. */
function issue(over: Partial<DispatchIssue> & { id: string }): DispatchIssue {
  return {
    title: over.id,
    path: `/root/${over.id}`,
    status: undefined,
    blockedBy: [],
    repo: "/repos/app",
    worktree: undefined,
    branch: undefined,
    deviation: undefined,
    body: "",
    ...over,
  };
}

/** A DispatchView wrapping the given issues. */
function view(issues: DispatchIssue[]): DispatchView {
  return { prdTitle: "PRD", prdBody: "", issues };
}

/** The ids the sweep classified as spawn-eligible, flattened across PRDs. */
function eligibleIds(swept: readonly SweptPrd[]): string[] {
  return swept.flatMap((p) =>
    p.frontier
      .filter((e) => e.classification === "spawn")
      .map((e) => e.issue.id),
  );
}

/** The ids the sweep classified as reviewer-eligible, flattened across PRDs. */
function reviewerIds(swept: readonly SweptPrd[]): string[] {
  return swept.flatMap((p) => p.reviewers.map((i) => i.id));
}

/**
 * A reviewable Issue, as the implementor leaves it: `ready-for-review` carrying
 * the repo, worktree, and branch the reviewer reads — the fields
 * `classifyReviewability` requires.
 */
function reviewable(
  over: Partial<DispatchIssue> & { id: string },
): DispatchIssue {
  return issue({
    status: "ready-for-review",
    repo: "/repos/app",
    worktree: "/wt/x",
    branch: "branch-x",
    ...over,
  });
}

describe("sweepFrontier — implementor edge", () => {
  it("returns a ready-for-agent Issue with all blockers done as spawn-eligible", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          issue({ id: "001.md", status: "done" }),
          issue({ id: "002.md", status: "ready-for-agent", blockedBy: ["001.md"] }),
        ]),
      },
    ]);

    expect(eligibleIds(swept)).toEqual(["002.md"]);
  });

  it("excludes a ready-for-agent Issue whose blocker is not yet done", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          issue({ id: "001.md", status: "in-progress" }),
          issue({ id: "002.md", status: "ready-for-agent", blockedBy: ["001.md"] }),
        ]),
      },
    ]);

    expect(eligibleIds(swept)).toEqual([]);
  });

  it("excludes ready-for-human, ready-for-review, missing-repo, and cyclic Issues", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          issue({ id: "human.md", status: "ready-for-human" }),
          issue({ id: "review.md", status: "ready-for-review" }),
          issue({ id: "norepo.md", status: "ready-for-agent", repo: undefined }),
          // a 2-cycle: each blocks the other, neither done
          issue({ id: "x.md", status: "ready-for-agent", blockedBy: ["y.md"] }),
          issue({ id: "y.md", status: "ready-for-agent", blockedBy: ["x.md"] }),
        ]),
      },
    ]);

    expect(eligibleIds(swept)).toEqual([]);
  });

  it("computes eligibility independently per PRD across the whole root", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p1",
        view: view([
          issue({ id: "a.md", status: "done" }),
          issue({ id: "b.md", status: "ready-for-agent", blockedBy: ["a.md"] }),
        ]),
      },
      {
        prdDir: "/root/p2",
        view: view([
          // p2's "a.md" is NOT p1's: blockers resolve within the PRD only.
          issue({ id: "a.md", status: "in-progress" }),
          issue({ id: "c.md", status: "ready-for-agent", blockedBy: ["a.md"] }),
        ]),
      },
    ]);

    // p1.b is eligible (its blocker is done); p2.c is not (its blocker isn't).
    expect(eligibleIds(swept)).toEqual(["b.md"]);
    // Each PRD keeps its own prdDir so the orchestrator can dispatch it.
    expect(swept.map((p) => p.prdDir)).toEqual(["/root/p1", "/root/p2"]);
  });

  it("carries each PRD's view through so the orchestrator can build prompts", () => {
    const v = view([issue({ id: "002.md", status: "ready-for-agent" })]);
    const swept = sweepFrontier([{ prdDir: "/root/p", view: v }]);

    expect(swept[0]?.view).toBe(v);
  });
});

describe("sweepFrontier — reviewer edge", () => {
  it("returns a ready-for-review Issue with repo, worktree, and branch as reviewer-eligible", () => {
    const swept = sweepFrontier([
      { prdDir: "/root/p", view: view([reviewable({ id: "001.md" })]) },
    ]);

    expect(reviewerIds(swept)).toEqual(["001.md"]);
  });

  it("excludes a ready-for-review Issue missing a repo", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          reviewable({ id: "norepo.md", repo: undefined }),
          // a blank repo is also "missing" — nothing to launch the reviewer in
          reviewable({ id: "blank.md", repo: "  " }),
        ]),
      },
    ]);

    expect(reviewerIds(swept)).toEqual([]);
  });

  it("excludes a ready-for-review Issue missing the worktree or branch the reviewer reads", () => {
    // Matches the `r` keybind (classifyReviewability): a hand-set or half-written
    // ready-for-review Issue without the implementor's recorded handoff fields
    // must not spawn a reviewer with nothing to check out or merge.
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          reviewable({ id: "noworktree.md", worktree: undefined }),
          reviewable({ id: "nobranch.md", branch: undefined }),
          reviewable({ id: "blankworktree.md", worktree: "  " }),
        ]),
      },
    ]);

    expect(reviewerIds(swept)).toEqual([]);
  });

  it("excludes Issues that are not ready-for-review", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          issue({ id: "agent.md", status: "ready-for-agent" }),
          issue({ id: "progress.md", status: "in-progress" }),
          issue({ id: "inreview.md", status: "in-review" }),
          issue({ id: "human.md", status: "ready-for-human" }),
          issue({ id: "done.md", status: "done" }),
          issue({ id: "none.md", status: undefined }),
        ]),
      },
    ]);

    expect(reviewerIds(swept)).toEqual([]);
  });

  it("computes reviewer candidates independently per PRD across the whole root", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p1",
        view: view([
          reviewable({ id: "a.md", repo: "/repos/p1" }),
          issue({ id: "b.md", status: "in-review", repo: "/repos/p1" }),
        ]),
      },
      {
        prdDir: "/root/p2",
        view: view([
          reviewable({ id: "c.md", repo: "/repos/p2" }),
          issue({ id: "d.md", status: "done", repo: "/repos/p2" }),
        ]),
      },
    ]);

    expect(reviewerIds(swept)).toEqual(["a.md", "c.md"]);
    expect(swept.map((p) => p.prdDir)).toEqual(["/root/p1", "/root/p2"]);
  });

  it("yields both edges from one sweep over the same PRD", () => {
    const swept = sweepFrontier([
      {
        prdDir: "/root/p",
        view: view([
          issue({ id: "impl.md", status: "ready-for-agent", repo: "/repos/app" }),
          reviewable({ id: "rev.md" }),
        ]),
      },
    ]);

    expect(eligibleIds(swept)).toEqual(["impl.md"]);
    expect(reviewerIds(swept)).toEqual(["rev.md"]);
  });
});
