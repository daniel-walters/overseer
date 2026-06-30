import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { computeFrontier } from "./frontier.js";
import { readDispatchView } from "./reader.js";
import type { DispatchIssue, DispatchView } from "./reader.js";

const mixedPrd = fileURLToPath(
  new URL("./__fixtures__/frontier/mixed-prd", import.meta.url),
);

/**
 * Build a {@link DispatchView} from a list of partial Issue specs, filling in
 * the boilerplate the frontier ignores (body, path). Mirrors the fixture style
 * of scanner.test.ts but in-memory: the frontier is pure data-in/data-out, so
 * its "fixtures" are records rather than files on disk.
 */
function view(issues: readonly Partial<DispatchIssue>[]): DispatchView {
  return {
    prdTitle: "",
    prdBody: "",
    issues: issues.map((i, n) => ({
      id: i.id ?? `${String(n).padStart(3, "0")}-issue.md`,
      title: i.title ?? i.id ?? "issue.md",
      path: i.path ?? `/root/prd/${i.id ?? "issue.md"}`,
      status: i.status,
      blockedBy: i.blockedBy ?? [],
      repo: i.repo,
      worktree: i.worktree,
      branch: i.branch,
      deviation: i.deviation,
      reviewVerdict: i.reviewVerdict,
      slice: i.slice,
      reviewFindings: i.reviewFindings,
      reviewTolerated: i.reviewTolerated,
      body: i.body ?? "",
    })),
  };
}

function classOf(view: DispatchView, id: string) {
  const entry = computeFrontier(view).find((e) => e.issue.id === id);
  if (!entry) throw new Error(`no frontier entry for "${id}"`);
  return entry;
}

describe("computeFrontier", () => {
  it("spawns a ready-for-agent Issue with a valid repo and no blockers", () => {
    const frontier = view([
      { id: "001-a.md", status: "ready-for-agent", repo: "/repos/backend" },
    ]);

    expect(classOf(frontier, "001-a.md").classification).toBe("spawn");
  });

  it("skips a ready-for-human Issue with its reason", () => {
    const frontier = view([
      { id: "001-a.md", status: "ready-for-human", repo: "/repos/backend" },
    ]);

    const entry = classOf(frontier, "001-a.md");
    expect(entry.classification).toBe("skipped");
    expect(entry.reason).toMatch(/ready-for-human/);
  });

  it("skips a non-ready status (backlog, in-progress, …) with its reason", () => {
    const frontier = view([
      { id: "001-a.md", status: "backlog", repo: "/repos/backend" },
      { id: "002-b.md", status: "in-progress", repo: "/repos/backend" },
      { id: "003-c.md", status: undefined, repo: "/repos/backend" },
    ]);

    for (const id of ["001-a.md", "002-b.md", "003-c.md"]) {
      expect(classOf(frontier, id).classification).toBe("skipped");
      expect(classOf(frontier, id).reason).toBeTruthy();
    }
  });

  it("skips a ready-for-agent Issue with a missing or blank repo, with reason", () => {
    const frontier = view([
      { id: "001-a.md", status: "ready-for-agent", repo: undefined },
      { id: "002-b.md", status: "ready-for-agent", repo: "   " },
    ]);

    for (const id of ["001-a.md", "002-b.md"]) {
      const entry = classOf(frontier, id);
      expect(entry.classification).toBe("skipped");
      expect(entry.reason).toMatch(/repo/);
    }
  });

  it("spawns a ready-for-agent Issue whose every blocker is done", () => {
    const frontier = view([
      { id: "001-a.md", status: "done", repo: "/repos/backend" },
      {
        id: "002-b.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["001-a.md"],
      },
    ]);

    expect(classOf(frontier, "002-b.md").classification).toBe("spawn");
  });

  it("queues a ready-for-agent Issue whose blocker is not yet done", () => {
    // in-review is the furthest an implementor takes a blocker; only the future
    // reviewer step sets done, so in-review still blocks.
    const frontier = view([
      { id: "001-a.md", status: "in-review", repo: "/repos/backend" },
      {
        id: "002-b.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["001-a.md"],
      },
    ]);

    const entry = classOf(frontier, "002-b.md");
    expect(entry.classification).toBe("queued");
    expect(entry.reason).toMatch(/001-a\.md/);
  });

  it("blocks (reports, never spawns) an Issue whose blocker file is missing", () => {
    const frontier = view([
      {
        id: "001-a.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["999-ghost.md"],
      },
    ]);

    const entry = classOf(frontier, "001-a.md");
    expect(entry.classification).toBe("blocked");
    expect(entry.reason).toMatch(/999-ghost\.md/);
  });

  it("blocks (reports) every Issue involved in a dependency cycle", () => {
    // a → b → a; neither can ever start, so both fail safe to blocked.
    const frontier = view([
      {
        id: "001-a.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["002-b.md"],
      },
      {
        id: "002-b.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["001-a.md"],
      },
    ]);

    for (const id of ["001-a.md", "002-b.md"]) {
      const entry = classOf(frontier, id);
      expect(entry.classification).toBe("blocked");
      expect(entry.reason).toMatch(/cycle/i);
    }
  });

  it("blocks an Issue caught in a self-loop", () => {
    const frontier = view([
      {
        id: "001-a.md",
        status: "ready-for-agent",
        repo: "/repos/backend",
        blockedBy: ["001-a.md"],
      },
    ]);

    expect(classOf(frontier, "001-a.md").classification).toBe("blocked");
  });

  it("treats an empty PRD as a valid, non-error empty frontier", () => {
    expect(computeFrontier(view([]))).toEqual([]);
  });

  it("preserves the reader's Issue order and identity in its output", () => {
    const frontier = computeFrontier(
      view([{ id: "001-a.md" }, { id: "002-b.md" }, { id: "003-c.md" }]),
    );

    expect(frontier.map((e) => e.issue.id)).toEqual([
      "001-a.md",
      "002-b.md",
      "003-c.md",
    ]);
  });
});

describe("computeFrontier over a fixture PRD", () => {
  function classifications(): Map<string, string> {
    const frontier = computeFrontier(readDispatchView(mixedPrd));
    return new Map(frontier.map((e) => [e.issue.id, e.classification]));
  }

  it("classifies every Issue by the rule it exercises", () => {
    expect(Object.fromEntries(classifications())).toEqual({
      // done blocker is irrelevant to its own classification (not ready)
      "001-foundation.md": "skipped",
      "002-spawnable.md": "spawn",
      "003-queued.md": "queued",
      "004-in-review-blocker.md": "skipped",
      "005-dangling.md": "blocked",
      "006-cycle-x.md": "blocked",
      "007-cycle-y.md": "blocked",
      "008-no-repo.md": "skipped",
      "009-human.md": "skipped",
      "010-backlog.md": "skipped",
    });
  });
});
