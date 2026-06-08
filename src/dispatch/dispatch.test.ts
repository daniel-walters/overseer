import { describe, it, expect, vi } from "vitest";
import { runDispatch, type DispatchDeps } from "./dispatch.js";
import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";
import type { GitSeam } from "./gitSetup.js";

/** A minimal DispatchIssue for a frontier entry under test. */
function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    path: overrides.path ?? `/root/prd/${overrides.id ?? "001-a.md"}`,
    status: overrides.status ?? "ready-for-agent",
    blockedBy: overrides.blockedBy ?? [],
    repo: "repo" in overrides ? overrides.repo : "/repos/backend",
    body: overrides.body ?? "",
  };
}

function entry(
  classification: FrontierEntry["classification"],
  overrides: Partial<DispatchIssue> = {},
): FrontierEntry {
  return { issue: issue(overrides), classification };
}

/**
 * A scriptable git seam that treats every repo as valid by default, so most
 * tests can focus on the spawn lifecycle. Individual tests opt a repo into
 * invalidity or branch-creation failure.
 */
function fakeGit(overrides: Partial<GitSeam> = {}): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => "origin/main"),
    branchExists: vi.fn(() => true),
    createBranch: vi.fn(),
    ...overrides,
  };
}

/** Seams that record what the dispatch did, with no real fs, git, or process. */
function deps(
  overrides: Partial<DispatchDeps> = {},
): DispatchDeps & {
  writes: [string, string][];
  spawns: { repo: string; prompt: string }[];
  failures: { issueId: string; repo: string; error: string }[];
} {
  const writes: [string, string][] = [];
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: { issueId: string; repo: string; error: string }[] = [];
  return {
    writes,
    spawns,
    failures,
    git: fakeGit(),
    writeStatus: (path, status) => writes.push([path, status]),
    buildPrompt: (i) => `prompt-for-${i.id}`,
    spawn: (repo, prompt) => spawns.push({ repo, prompt }),
    logFailure: (r) => failures.push(r),
    ...overrides,
  };
}

const PRD_DIR = "/root/prd";

describe("runDispatch", () => {
  it("flips each spawn candidate to in-progress, then spawns it with its built prompt and repo", () => {
    const d = deps();
    runDispatch(
      PRD_DIR,
      [
        entry("spawn", { id: "001-a.md", path: "/root/prd/001-a.md", repo: "/repos/api" }),
        entry("spawn", { id: "002-b.md", path: "/root/prd/002-b.md", repo: "/repos/web" }),
      ],
      d,
    );

    expect(d.writes).toEqual([
      ["/root/prd/001-a.md", "in-progress"],
      ["/root/prd/002-b.md", "in-progress"],
    ]);
    expect(d.spawns).toEqual([
      { repo: "/repos/api", prompt: "prompt-for-001-a.md" },
      { repo: "/repos/web", prompt: "prompt-for-002-b.md" },
    ]);
  });

  it("flips a candidate's status before spawning it", () => {
    const order: string[] = [];
    runDispatch(
      PRD_DIR,
      [entry("spawn", { id: "001-a.md" })],
      deps({
        writeStatus: (_path, status) => order.push(`write:${status}`),
        spawn: () => order.push("spawn"),
      }),
    );

    expect(order).toEqual(["write:in-progress", "spawn"]);
  });

  it("ensures each distinct repo's feature branch before spawning, once per repo", () => {
    const git = fakeGit({ branchExists: vi.fn(() => false) });
    runDispatch(
      PRD_DIR,
      [
        entry("spawn", { id: "001-a.md", repo: "/repos/api" }),
        entry("spawn", { id: "002-b.md", repo: "/repos/api" }),
        entry("spawn", { id: "003-c.md", repo: "/repos/web" }),
      ],
      deps({ git }),
    );

    // De-duplicated: branch ensured once per repo, not once per Issue.
    expect((git.createBranch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(git.createBranch).toHaveBeenCalledWith("/repos/api", "prd", "origin/main");
    expect(git.createBranch).toHaveBeenCalledWith("/repos/web", "prd", "origin/main");
  });

  it("ignores queued, blocked, and skipped entries entirely", () => {
    const d = deps();
    runDispatch(
      PRD_DIR,
      [
        entry("queued", { id: "001-q.md" }),
        entry("blocked", { id: "002-x.md" }),
        entry("skipped", { id: "003-s.md" }),
      ],
      d,
    );

    expect(d.writes).toEqual([]);
    expect(d.spawns).toEqual([]);
    expect(d.failures).toEqual([]);
  });

  it("acts only on the spawn candidates within a mixed frontier", () => {
    const d = deps();
    runDispatch(
      PRD_DIR,
      [
        entry("skipped", { id: "001-s.md" }),
        entry("spawn", { id: "002-go.md", path: "/root/prd/002-go.md", repo: "/repos/api" }),
        entry("queued", { id: "003-q.md" }),
      ],
      d,
    );

    expect(d.writes).toEqual([["/root/prd/002-go.md", "in-progress"]]);
    expect(d.spawns).toEqual([{ repo: "/repos/api", prompt: "prompt-for-002-go.md" }]);
  });

  it("does nothing for an empty frontier", () => {
    const d = deps();
    runDispatch(PRD_DIR, [], d);
    expect(d.writes).toEqual([]);
    expect(d.spawns).toEqual([]);
    expect(d.failures).toEqual([]);
  });

  describe("repo validation gating", () => {
    it("skips an Issue whose repo is invalid: not flipped, not spawned, not logged as a failure", () => {
      const git = fakeGit({
        isGitRepo: vi.fn((repo: string) => repo !== "/repos/bad"),
      });
      const d = deps({ git });
      runDispatch(
        PRD_DIR,
        [
          entry("spawn", { id: "001-bad.md", path: "/root/prd/001-bad.md", repo: "/repos/bad" }),
          entry("spawn", { id: "002-ok.md", path: "/root/prd/002-ok.md", repo: "/repos/ok" }),
        ],
        d,
      );

      // The bad Issue is never moved (acceptance: missing/invalid repo never flipped).
      expect(d.writes).toEqual([["/root/prd/002-ok.md", "in-progress"]]);
      expect(d.spawns).toEqual([{ repo: "/repos/ok", prompt: "prompt-for-002-ok.md" }]);
      // A pre-spawn skip is reported via the modal, not the failure log.
      expect(d.failures).toEqual([]);
    });

    it("skips a spawn candidate with no repo at all without flipping it", () => {
      const d = deps();
      runDispatch(
        PRD_DIR,
        [entry("spawn", { id: "001-norepo.md", path: "/root/prd/001-norepo.md", repo: undefined })],
        d,
      );

      expect(d.writes).toEqual([]);
      expect(d.spawns).toEqual([]);
    });

    it("skips an Issue whose feature-branch setup fails, without flipping it", () => {
      const git = fakeGit({
        branchExists: vi.fn(() => false),
        createBranch: vi.fn((repo: string) => {
          if (repo === "/repos/api") throw new Error("git branch failed");
        }),
      });
      const d = deps({ git });
      runDispatch(
        PRD_DIR,
        [entry("spawn", { id: "001-a.md", path: "/root/prd/001-a.md", repo: "/repos/api" })],
        d,
      );

      expect(d.writes).toEqual([]);
      expect(d.spawns).toEqual([]);
    });
  });

  describe("spawn failure: rollback and logging", () => {
    it("rolls a candidate back to ready-for-agent when its spawn throws", () => {
      const d = deps({
        spawn: () => {
          throw new Error("claude not found");
        },
      });
      runDispatch(
        PRD_DIR,
        [entry("spawn", { id: "001-a.md", path: "/root/prd/001-a.md", repo: "/repos/api" })],
        d,
      );

      expect(d.writes).toEqual([
        ["/root/prd/001-a.md", "in-progress"],
        ["/root/prd/001-a.md", "ready-for-agent"],
      ]);
      expect(d.spawns).toEqual([]);
    });

    it("appends a failure record (issue, repo, error) when a spawn throws", () => {
      const d = deps({
        spawn: () => {
          throw new Error("claude not found");
        },
      });
      runDispatch(
        PRD_DIR,
        [entry("spawn", { id: "001-a.md", path: "/root/prd/001-a.md", repo: "/repos/api" })],
        d,
      );

      expect(d.failures).toEqual([
        { issueId: "001-a.md", repo: "/repos/api", error: "claude not found" },
      ]);
    });

    it("a failed spawn does not abort the wave: later candidates still spawn", () => {
      const d = deps({
        spawn: (repo, prompt) => {
          if (repo === "/repos/bad") throw new Error("boom");
          d.spawns.push({ repo, prompt });
        },
      });
      runDispatch(
        PRD_DIR,
        [
          entry("spawn", { id: "001-bad.md", path: "/root/prd/001-bad.md", repo: "/repos/bad" }),
          entry("spawn", { id: "002-ok.md", path: "/root/prd/002-ok.md", repo: "/repos/ok" }),
        ],
        d,
      );

      expect(d.spawns).toEqual([{ repo: "/repos/ok", prompt: "prompt-for-002-ok.md" }]);
      expect(d.failures).toEqual([
        { issueId: "001-bad.md", repo: "/repos/bad", error: "boom" },
      ]);
    });
  });

  it("skips spawning a candidate whose flip throws, and continues with the rest", () => {
    // The flip is the spawn's precondition: a candidate whose file vanished from
    // the watched root (ENOENT on the flip) must not be spawned, and one bad
    // candidate must not abort the whole wave.
    const d = deps({
      writeStatus: (path, status) => {
        if (path === "/root/prd/001-gone.md") throw new Error("ENOENT");
        d.writes.push([path, status]);
      },
    });
    runDispatch(
      PRD_DIR,
      [
        entry("spawn", { id: "001-gone.md", path: "/root/prd/001-gone.md", repo: "/repos/api" }),
        entry("spawn", { id: "002-ok.md", path: "/root/prd/002-ok.md", repo: "/repos/api" }),
      ],
      d,
    );

    expect(d.spawns).toEqual([{ repo: "/repos/api", prompt: "prompt-for-002-ok.md" }]);
  });
});
