import { describe, it, expect } from "vitest";
import { sweepImplementorFrontier, type SweptPrd } from "./sweep.js";
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

describe("sweepImplementorFrontier", () => {
  it("returns a ready-for-agent Issue with all blockers done as spawn-eligible", () => {
    const swept = sweepImplementorFrontier([
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
    const swept = sweepImplementorFrontier([
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
    const swept = sweepImplementorFrontier([
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
    const swept = sweepImplementorFrontier([
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
    const swept = sweepImplementorFrontier([{ prdDir: "/root/p", view: v }]);

    expect(swept[0]?.view).toBe(v);
  });
});
