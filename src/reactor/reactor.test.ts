import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactor, type ReactorDeps } from "./reactor.js";
import type { GitSeam } from "../dispatch/gitSetup.js";
import type { MergeSeam } from "../review/mergeSeam.js";

/** A git seam that treats every repo as valid with the branch already present. */
function fakeGit(overrides: Partial<GitSeam> = {}): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => "origin/main"),
    branchExists: vi.fn(() => true),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
    ...overrides,
  };
}

/**
 * A merge seam that records its calls and, by default, treats every worktree as
 * clean and every git step as succeeding — the clean-merge happy path. Override a
 * method to exercise a failure (e.g. `merge` throwing) or a totality backstop
 * (e.g. `isWorktreeClean` throwing).
 */
function fakeMergeSeam(
  overrides: Partial<MergeSeam> = {},
): MergeSeam & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isWorktreeClean: vi.fn(() => true),
    checkout: vi.fn(() => void calls.push("checkout")),
    merge: vi.fn(() => void calls.push("merge")),
    conflictingPaths: vi.fn(() => []),
    abortMerge: vi.fn(() => void calls.push("abortMerge")),
    removeWorktree: vi.fn(() => void calls.push("removeWorktree")),
    deleteBranch: vi.fn(() => void calls.push("deleteBranch")),
    ...overrides,
  };
}

/** Recording seams so we can assert which spawns happened and which failed. */
function recordingDeps(overrides: Partial<ReactorDeps> = {}): ReactorDeps & {
  spawns: { repo: string; prompt: string }[];
  failures: unknown[];
  recorded: { issueKey: string; handle: string; reviewPass?: number }[];
} {
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: unknown[] = [];
  const recorded: { issueKey: string; handle: string; reviewPass?: number }[] =
    [];
  return {
    spawns,
    failures,
    recorded,
    git: fakeGit(),
    spawn: (repo, prompt) => {
      spawns.push({ repo, prompt });
      return `handle-${repo}`;
    },
    logFailure: (r) => failures.push(r),
    recordHandle: (issueKey, handle, reviewPass) =>
      recorded.push({ issueKey, handle, reviewPass }),
    ...overrides,
  };
}

/** Write a PRD directory with a prd.md and the given Issue files. */
function writePrd(
  root: string,
  name: string,
  issues: Record<string, string>,
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prd.md"), `---\ntitle: ${name}\n---\n\nBody of ${name}.\n`);
  for (const [file, contents] of Object.entries(issues)) {
    writeFileSync(join(dir, file), contents);
  }
}

const fm = (fields: Record<string, string>, body = "body"): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

describe("createReactor", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-reactor-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flips and spawns exactly the eligible candidates across all PRDs", () => {
    writePrd(root, "alpha", {
      "001-base.md": fm({ status: "done", repo: "/repos/alpha" }),
      "002-go.md": fm({
        status: "ready-for-agent",
        repo: "/repos/alpha",
        blocked_by: "[001-base.md]",
      }),
    });
    writePrd(root, "beta", {
      // blocker not done ⇒ not eligible this pass
      "001-base.md": fm({ status: "in-progress", repo: "/repos/beta" }),
      "002-wait.md": fm({
        status: "ready-for-agent",
        repo: "/repos/beta",
        blocked_by: "[001-base.md]",
      }),
      // no blockers, ready ⇒ eligible
      "003-free.md": fm({ status: "ready-for-agent", repo: "/repos/beta" }),
    });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    // Exactly the two eligible Issues spawned, in their repos.
    expect(deps.spawns.map((s) => s.repo).sort()).toEqual([
      "/repos/alpha",
      "/repos/beta",
    ]);
    // Their files flipped to in-progress on disk.
    expect(readFileSync(join(root, "alpha", "002-go.md"), "utf8")).toContain(
      "status: in-progress",
    );
    expect(readFileSync(join(root, "beta", "003-free.md"), "utf8")).toContain(
      "status: in-progress",
    );
    // The waiting one stayed put.
    expect(readFileSync(join(root, "beta", "002-wait.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );
  });

  it("cascades: completing a blocker unblocks its sibling on the next reconcile", () => {
    writePrd(root, "alpha", {
      "001-base.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
      "002-next.md": fm({
        status: "ready-for-agent",
        repo: "/repos/alpha",
        blocked_by: "[001-base.md]",
      }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    // First pass: only 001 is unblocked.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);
    expect(readFileSync(join(root, "alpha", "002-next.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );

    // The implementor finishes 001 → done (simulated on disk).
    writeFileSync(
      join(root, "alpha", "001-base.md"),
      fm({ status: "done", repo: "/repos/alpha" }),
    );

    // Next pass: 002's blocker is now done, so it spawns.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(2);
    expect(readFileSync(join(root, "alpha", "002-next.md"), "utf8")).toContain(
      "status: in-progress",
    );
  });

  it("rolls a failed spawn back to ready-for-agent and logs it", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps({
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    createReactor(root, deps).reconcile();

    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );
    expect(deps.failures).toEqual([
      {
        issueId: "001-go.md",
        repo: "/repos/alpha",
        error: "claude: command not found",
        edge: "implementor",
      },
    ]);
  });

  it("does not re-spawn an Issue whose spawn just failed, on the next reconcile", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    // First spawn fails ⇒ rolled back to ready-for-agent and recorded.
    const deps = recordingDeps({
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    const reactor = createReactor(root, deps);

    reactor.reconcile();
    expect(deps.spawns).toHaveLength(0); // the throwing spawn launched nothing
    expect(deps.failures).toHaveLength(1);
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );

    // The Issue is still ready-for-agent on disk, so the frontier would re-pick
    // it — but the failed-set suppresses it. A second reconcile is a no-op: no
    // new spawn attempt, no new failure logged.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(0);
    expect(deps.failures).toHaveLength(1);
  });

  it("suppression is per-PRD: a failure does not suppress a same-named Issue in another PRD", () => {
    // Two PRDs with an identically-named Issue file. Issue filenames are only
    // unique within a PRD, but the Reactor sweeps across all PRDs — so a failure
    // in alpha must not suppress beta's distinct Issue of the same filename.
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    writePrd(root, "beta", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/beta" }),
    });

    // alpha's spawn fails; beta's would succeed.
    const deps = recordingDeps({
      spawn: (repo, prompt) => {
        if (repo === "/repos/alpha") throw new Error("alpha is broken");
        deps.spawns.push({ repo, prompt });
      },
    });
    const reactor = createReactor(root, deps);

    reactor.reconcile();
    // beta spawned on the first pass; alpha failed and was recorded.
    expect(deps.spawns.map((s) => s.repo)).toEqual(["/repos/beta"]);
    expect(deps.failures).toHaveLength(1);

    // beta finished its work (flipped off ready-for-agent), so only alpha would
    // re-spawn — but alpha is suppressed. A second pass attempts nothing new.
    reactor.reconcile();
    expect(deps.spawns.map((s) => s.repo)).toEqual(["/repos/beta"]);
  });

  it("records the spawn failure per-edge, leaving the same Issue's reviewer edge free", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const failed: { issueKey: string; edge: string }[] = [];
    const deps = recordingDeps({
      spawn: () => {
        throw new Error("boom");
      },
      failedSet: {
        record: (issueKey, edge) => failed.push({ issueKey, edge }),
        has: () => false, // no suppression, so we observe the record() call only
      },
    });
    createReactor(root, deps).reconcile();

    // Keyed by full path (prdDir/filename), under the implementor edge.
    expect(failed).toEqual([
      { issueKey: join(root, "alpha", "001-go.md"), edge: "implementor" },
    ]);
  });

  it("retries a previously-failed spawn on a fresh reactor instance (session-scoped)", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    // First instance: spawn fails, Issue suppressed for that session.
    const failingDeps = recordingDeps({
      spawn: () => {
        throw new Error("transient");
      },
    });
    const first = createReactor(root, failingDeps);
    first.reconcile();
    first.reconcile();
    expect(failingDeps.failures).toHaveLength(1); // suppressed after the first

    // A fresh instance (reopen): the environment is fixed and the spawn now
    // succeeds. The new instance builds a fresh failed-set, so it retries.
    const healthyDeps = recordingDeps();
    createReactor(root, healthyDeps).reconcile();
    expect(healthyDeps.spawns).toHaveLength(1);
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: in-progress",
    );
  });

  it("is a no-op when called re-entrantly (reconcile during reconcile)", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const spawns: { repo: string; prompt: string }[] = [];
    let reactor: ReturnType<typeof createReactor>;
    let reentrantSpawns = -1;
    const deps = recordingDeps({
      // Re-enter reconcile from inside a spawn; the inner call must be a no-op.
      spawn: (repo, prompt) => {
        spawns.push({ repo, prompt });
        reactor.reconcile(); // re-entrant
        reentrantSpawns = spawns.length;
      },
    });
    reactor = createReactor(root, deps);

    reactor.reconcile();

    // The inner reconcile spawned nothing extra (guard held).
    expect(reentrantSpawns).toBe(1);
    expect(spawns).toHaveLength(1);
  });

  it("releases the re-entrancy guard so a later reconcile runs normally", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);

    // A fresh ready Issue appears; the next reconcile picks it up.
    writeFileSync(
      join(root, "alpha", "002-more.md"),
      fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    );
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(2);
  });

  it("skips a vanished/unreadable PRD mid-sweep without throwing", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    // A PRD whose Issue read throws mid-sweep: a path where a .md file is
    // expected is actually a directory, so readDispatchView's readFileSync
    // raises EISDIR. The Reactor must skip this PRD, not crash the board.
    const ghost = join(root, "ghost");
    mkdirSync(ghost);
    writeFileSync(join(ghost, "prd.md"), "---\ntitle: ghost\n---\n");
    mkdirSync(join(ghost, "001-broken.md")); // a dir where a file is expected

    const deps = recordingDeps();

    expect(() => createReactor(root, deps).reconcile()).not.toThrow();
    // The healthy PRD still dispatched.
    expect(deps.spawns).toHaveLength(1);
    expect(deps.spawns[0]?.repo).toBe("/repos/alpha");
  });

  it("does not throw when the root itself vanishes", () => {
    rmSync(root, { recursive: true, force: true });
    const deps = recordingDeps();
    expect(() => createReactor(root, deps).reconcile()).not.toThrow();
    expect(deps.spawns).toEqual([]);
  });

  it("builds an implementor prompt carrying the Issue, PRD body, repo, and feature branch", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    const prompt = deps.spawns[0]?.prompt ?? "";
    expect(prompt).toContain("/repos/alpha"); // repo
    expect(prompt).toContain("alpha"); // slugified PRD dir = feature branch
    expect(prompt).toContain("Body of alpha."); // PRD body
    expect(prompt).toContain("001-go.md"); // the Issue file
  });

  // A ready-for-review Issue, as the implementor leaves it: repo to launch the
  // reviewer in, plus the recorded worktree/branch the reviewer reads.
  const reviewable = (repo = "/repos/alpha"): string =>
    fm({
      status: "ready-for-review",
      repo,
      worktree: "/wt/issue",
      branch: "issue-branch",
    });

  it("flips and spawns a reviewer for a ready-for-review Issue with no `r` press", () => {
    writePrd(root, "alpha", { "001-review.md": reviewable() });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    // A reviewer spawned in the Issue's repo, and the file flipped to in-review.
    expect(deps.spawns).toHaveLength(1);
    expect(deps.spawns[0]?.repo).toBe("/repos/alpha");
    expect(readFileSync(join(root, "alpha", "001-review.md"), "utf8")).toContain(
      "status: in-review",
    );
  });

  it("spawns reviewers for exactly the eligible Issues across PRDs", () => {
    writePrd(root, "alpha", {
      // eligible
      "001-rev.md": reviewable("/repos/alpha"),
      // not ready-for-review ⇒ no reviewer
      "002-mid.md": fm({ status: "in-review", repo: "/repos/alpha" }),
    });
    writePrd(root, "beta", {
      // eligible
      "001-rev.md": reviewable("/repos/beta"),
      // ready-for-review but no repo ⇒ excluded by the sweep
      "002-norepo.md": fm({ status: "ready-for-review" }),
    });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    expect(deps.spawns.map((s) => s.repo).sort()).toEqual([
      "/repos/alpha",
      "/repos/beta",
    ]);
    // The no-repo Issue was left untouched.
    expect(readFileSync(join(root, "beta", "002-norepo.md"), "utf8")).toContain(
      "status: ready-for-review",
    );
  });

  it("drives both edges in one reconcile: an implementor and a reviewer", () => {
    writePrd(root, "alpha", {
      "001-impl.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
      "002-rev.md": reviewable("/repos/alpha"),
    });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    expect(deps.spawns).toHaveLength(2);
    expect(readFileSync(join(root, "alpha", "001-impl.md"), "utf8")).toContain(
      "status: in-progress",
    );
    expect(readFileSync(join(root, "alpha", "002-rev.md"), "utf8")).toContain(
      "status: in-review",
    );
  });

  it("rolls a failed reviewer spawn back to ready-for-review and logs it", () => {
    writePrd(root, "alpha", { "001-rev.md": reviewable("/repos/alpha") });

    const deps = recordingDeps({
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    createReactor(root, deps).reconcile();

    expect(readFileSync(join(root, "alpha", "001-rev.md"), "utf8")).toContain(
      "status: ready-for-review",
    );
    expect(deps.failures).toEqual([
      {
        issueId: "001-rev.md",
        repo: "/repos/alpha",
        error: "claude: command not found",
        edge: "reviewer",
      },
    ]);
  });

  it("does not double-spawn a reviewer across overlapping passes (flip is the lock)", () => {
    writePrd(root, "alpha", { "001-rev.md": reviewable("/repos/alpha") });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    // First pass flips it to in-review and spawns once.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);

    // A later pass sees it already in-review ⇒ off the frontier ⇒ no re-spawn.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);
  });

  it("builds a reviewer prompt carrying the worktree to review", () => {
    // Since ADR 0019 the agent no longer merges, so the prompt carries the
    // worktree to review but not the branch/feature-branch merge target.
    writePrd(root, "alpha", { "001-rev.md": reviewable("/repos/alpha") });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    const prompt = deps.spawns[0]?.prompt ?? "";
    expect(prompt).toContain("/wt/issue"); // recorded worktree
    expect(prompt).toContain("/repos/alpha"); // repo the review runs in
    expect(prompt).toContain("reviewer"); // reviewer brief, not implementor
  });

  it("cascades both edges: review reaching done re-dispatches the unblocked sibling", () => {
    // 002 is blocked by 001. 001 sits in review; once it merges to done, the
    // Reactor must re-dispatch 002 — with no `r` and no second `d`.
    writePrd(root, "alpha", {
      "001-base.md": reviewable("/repos/alpha"),
      "002-next.md": fm({
        status: "ready-for-agent",
        repo: "/repos/alpha",
        blocked_by: "[001-base.md]",
      }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);
    const pass001 = join(root, "alpha", "001-base.md");
    const pass002 = join(root, "alpha", "002-next.md");

    // Pass 1: 001 gets a reviewer; 002 stays put (its blocker isn't done).
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);
    expect(readFileSync(pass001, "utf8")).toContain("status: in-review");
    expect(readFileSync(pass002, "utf8")).toContain("status: ready-for-agent");

    // The reviewer converges and merges: 001 → done (simulated on disk).
    writeFileSync(pass001, fm({ status: "done", repo: "/repos/alpha" }));

    // Pass 2: 001's done unblocks 002, so an implementor is dispatched for it.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(2);
    expect(readFileSync(pass002, "utf8")).toContain("status: in-progress");
  });

  it("does not re-spawn a reviewer whose spawn just failed, on the next reconcile", () => {
    // The failed-set covers the reviewer edge too: a reviewer launch that fails
    // rolls back to ready-for-review and is recorded, so the next level-triggered
    // pass — which still sees ready-for-review on disk — does not retry forever.
    writePrd(root, "alpha", { "001-rev.md": reviewable("/repos/alpha") });

    const deps = recordingDeps({
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    const reactor = createReactor(root, deps);
    const file = join(root, "alpha", "001-rev.md");

    reactor.reconcile();
    expect(deps.spawns).toHaveLength(0); // the throwing spawn launched nothing
    expect(deps.failures).toEqual([
      {
        issueId: "001-rev.md",
        repo: "/repos/alpha",
        error: "claude: command not found",
        edge: "reviewer",
      },
    ]);
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-review");

    // Still ready-for-review on disk, so the sweep re-selects it — but the
    // reviewer-edge failed-set suppresses it: no new attempt, no new failure.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(0);
    expect(deps.failures).toHaveLength(1);
  });

  it("spawns nothing while auto-run is disabled", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);
    reactor.setEnabled(false);

    reactor.reconcile();

    expect(deps.spawns).toHaveLength(0);
    // The Issue is untouched on disk — not even flipped off its awaiting status.
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );
  });

  it("catches up when auto-run is re-enabled: it reconciles immediately", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);
    reactor.setEnabled(false);
    reactor.reconcile(); // muzzled: nothing happens
    expect(deps.spawns).toHaveLength(0);

    // Re-enabling acts on everything eligible right now, with no filesystem event.
    reactor.setEnabled(true);

    expect(deps.spawns).toHaveLength(1);
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: in-progress",
    );
  });

  it("does not spawn merely by being switched off", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.setEnabled(false); // turning off must not itself reconcile

    expect(deps.spawns).toHaveLength(0);
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );
  });

  it("a failed implementor edge does not suppress the reviewer edge for the same Issue", () => {
    // The failed-set is keyed by (issue, edge), so a recorded implementor failure
    // must not mask a later reviewer spawn on that same Issue — they are
    // independent edges (PRD User Story 10).
    writePrd(root, "alpha", {
      "001.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    let mode: "impl" | "review" = "impl";
    const deps = recordingDeps({
      spawn: (repo, prompt) => {
        if (mode === "impl") throw new Error("impl launch failed");
        deps.spawns.push({ repo, prompt });
      },
    });
    const reactor = createReactor(root, deps);
    const file = join(root, "alpha", "001.md");

    // Implementor spawn fails ⇒ rolled back to ready-for-agent, (001, implementor) recorded.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(0);
    expect(deps.failures).toHaveLength(1);

    // The Issue advances to ready-for-review (the implementor eventually ran, or
    // a human moved it). The reviewer edge is a *different* key, so it spawns.
    mode = "review";
    writeFileSync(
      file,
      fm({
        status: "ready-for-review",
        repo: "/repos/alpha",
        worktree: "/wt/x",
        branch: "b",
      }),
    );
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1); // reviewer not suppressed by the impl failure
    expect(readFileSync(file, "utf8")).toContain("status: in-review");
  });

  // The Reactor drives the AI-review loop one pass per spawn (ADR 0018): on each
  // ready-for-review Issue it reads the pass count `N` recorded in the sidecar,
  // and either spawns the next pass (recording `N+1`) or — at the cap — escalates
  // to human-review with `non-convergence`, the count being both the loop control
  // and the card's `N/cap` marker.
  describe("review-pass cap enforcement", () => {
    it("spawns the first pass and records reviewPass 1 when no pass is recorded yet", () => {
      // An absent count reads as the first pass: the reviewer is spawned and the
      // sidecar records 1, so the card's marker reads 1/cap the instant review
      // begins.
      writePrd(root, "alpha", { "001-review.md": reviewable() });

      const deps = recordingDeps();
      createReactor(root, deps).reconcile();

      expect(deps.spawns).toHaveLength(1);
      expect(deps.recorded).toEqual([
        {
          issueKey: join(root, "alpha", "001-review.md"),
          handle: "handle-/repos/alpha",
          reviewPass: 1,
        },
      ]);
    });

    it("spawns the next pass and records N+1 when N is below the cap", () => {
      // Two passes have run (N=2, cap=3); the next reconcile spawns the third pass
      // and records 3. The card's marker would tick 2/3 → 3/3.
      writePrd(root, "alpha", { "001-review.md": reviewable() });
      const issueKey = join(root, "alpha", "001-review.md");

      const deps = recordingDeps({
        readReviewPass: (key) => (key === issueKey ? 2 : undefined),
        review: { cap: 3, effort: "medium" },
      });
      createReactor(root, deps).reconcile();

      expect(deps.spawns).toHaveLength(1);
      expect(deps.recorded).toEqual([
        { issueKey, handle: "handle-/repos/alpha", reviewPass: 3 },
      ]);
      // It flipped to in-review (the idempotency lock) before spawning.
      expect(readFileSync(issueKey, "utf8")).toContain("status: in-review");
    });

    it("escalates to human-review with non-convergence at the cap and does not spawn", () => {
      // N has reached the cap (3 passes recorded, cap 3): the loop did not
      // converge, so the Reactor escalates to human-review with `non-convergence`
      // — and spawns no further pass.
      writePrd(root, "alpha", { "001-review.md": reviewable() });
      const issueKey = join(root, "alpha", "001-review.md");

      const deps = recordingDeps({
        readReviewPass: (key) => (key === issueKey ? 3 : undefined),
        review: { cap: 3, effort: "medium" },
      });
      createReactor(root, deps).reconcile();

      expect(deps.spawns).toEqual([]); // no 4th pass
      expect(deps.recorded).toEqual([]); // nothing recorded — no spawn happened
      const after = readFileSync(issueKey, "utf8");
      expect(after).toContain("status: human-review");
      expect(after).toContain("human_review_reason: non-convergence");
      // The reason is the Reactor-owned one and carries a note for the human.
      expect(after).toContain("human_review_note:");
    });

    it("advances the count across the between-passes return to ready-for-review", () => {
      // A found-and-fixed pass returns the Issue to ready-for-review; the next
      // reconcile re-picks it up and spawns the *next* pass, the count advancing
      // because the sidecar now reads one higher. Simulate the recorded count
      // climbing as the agent hands work back.
      writePrd(root, "alpha", { "001-review.md": reviewable() });
      const issueKey = join(root, "alpha", "001-review.md");

      let recorded: number | undefined;
      const deps = recordingDeps({
        readReviewPass: () => recorded,
        review: { cap: 3, effort: "medium" },
        // Spawning records the pass; mirror that into the sidecar fake so the
        // next reconcile reads the advanced count.
        spawn: (repo, prompt) => {
          deps.spawns.push({ repo, prompt });
          return `handle-${repo}`;
        },
        recordHandle: (key, handle, reviewPass) => {
          deps.recorded.push({ issueKey: key, handle, reviewPass });
          recorded = reviewPass;
        },
      });
      const reactor = createReactor(root, deps);

      // Pass 1 spawns and records 1.
      reactor.reconcile();
      expect(deps.recorded.at(-1)?.reviewPass).toBe(1);

      // The agent finds-and-fixes and hands back: ready-for-review again.
      writeFileSync(issueKey, reviewable());

      // Pass 2: the count advanced to 2.
      reactor.reconcile();
      expect(deps.recorded.at(-1)?.reviewPass).toBe(2);
      expect(deps.spawns).toHaveLength(2);
    });

    it("stops the loop on a clean exit: a done Issue is never re-spawned", () => {
      // A zero-findings clean pass merges and sets done. `done` is off the review
      // frontier, so the next reconcile spawns nothing — the loop halts.
      writePrd(root, "alpha", { "001-review.md": reviewable() });
      const issueKey = join(root, "alpha", "001-review.md");

      const deps = recordingDeps({ review: { cap: 3, effort: "medium" } });
      const reactor = createReactor(root, deps);

      reactor.reconcile(); // pass 1 spawns
      expect(deps.spawns).toHaveLength(1);

      // The reviewer converges and merges: 001 → done.
      writeFileSync(issueKey, fm({ status: "done", repo: "/repos/alpha" }));

      reactor.reconcile(); // nothing eligible
      expect(deps.spawns).toHaveLength(1); // no further pass
    });
  });
});

/**
 * The board-level activity signal the Reactor exposes (Issue: surface reactor
 * state) — the second surfaced reactor-state overlay, distinct from the auto-run
 * on/off indicator. It reports whether the Reactor is **working** (the last
 * reconcile spawned), **idle** (on but nothing eligible last reconcile), or
 * **at-rest** (auto-run off). Derived from in-memory state only, never disk.
 */
describe("createReactor activity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-reactor-activity-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts idle: on by default, nothing reconciled yet", () => {
    const reactor = createReactor(root, recordingDeps());
    expect(reactor.activity()).toBe("idle");
  });

  it("reports working after a reconcile that spawns", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.reconcile();

    expect(deps.spawns).toHaveLength(1);
    expect(reactor.activity()).toBe("working");
  });

  it("reports idle after a reconcile that spawns nothing", () => {
    // Everything is done — nothing eligible — so the reconcile spawns nothing and
    // the board is still because there's no work, not because it's braked.
    writePrd(root, "alpha", {
      "001-done.md": fm({ status: "done", repo: "/repos/alpha" }),
    });
    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.reconcile();

    expect(deps.spawns).toHaveLength(0);
    expect(reactor.activity()).toBe("idle");
  });

  it("falls back to idle once a working pass is followed by an empty one", () => {
    // The signal reflects the *most recent* reconcile, not a sticky high-water
    // mark: once the spawn wave drains, the Reactor reads idle again.
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.reconcile(); // spawns 001 → working
    expect(reactor.activity()).toBe("working");

    // 001 is now in-progress (flipped before spawn); a second reconcile finds
    // nothing eligible.
    reactor.reconcile();
    expect(deps.spawns).toHaveLength(1);
    expect(reactor.activity()).toBe("idle");
  });

  it("reports at-rest whenever auto-run is off, regardless of the last spawn", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    reactor.reconcile(); // working
    expect(reactor.activity()).toBe("working");

    reactor.setEnabled(false);
    expect(reactor.activity()).toBe("at-rest");
  });

  it("returns to working when auto-run is re-enabled and the catch-up reconcile spawns", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    const deps = recordingDeps();
    const reactor = createReactor(root, deps);
    reactor.setEnabled(false);
    expect(reactor.activity()).toBe("at-rest");

    // Re-enabling runs an immediate catch-up reconcile that spawns the eligible
    // Issue, so the signal flips at-rest → working off that pass.
    reactor.setEnabled(true);

    expect(deps.spawns).toHaveLength(1);
    expect(reactor.activity()).toBe("working");
  });
});

/**
 * The third, non-spawn reconcile edge (ADR 0019): after the two spawn frontiers,
 * the Reactor sweeps `in-review` Issues carrying `review_verdict: clean` and
 * resolves each — merging the worktree branch into the feature branch and writing
 * `done` — synchronously, under the same re-entrancy guard, gated on the verdict
 * (not on liveness). The merge is Overseer's now, not the agent's.
 */
describe("createReactor — resolve edge", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-reactor-resolve-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // An in-review Issue carrying a clean verdict, as the pass agent leaves it: the
  // implementor's recorded repo/worktree/branch plus `review_verdict: clean`.
  const cleanVerdict = (repo = "/repos/alpha"): string =>
    fm({
      status: "in-review",
      repo,
      worktree: "/wt/issue",
      branch: "issue-branch",
      review_verdict: "clean",
    });

  it("resolves a clean verdict: merges, writes done, and cleans up the worktree", () => {
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam();
    const deps = recordingDeps({ merge });

    createReactor(root, deps).reconcile();

    // The merge ran (feature-branch checkout + merge), then the worktree was torn
    // down — and the Issue reached done on disk, with no agent performing the merge.
    expect(merge.calls).toEqual([
      "checkout",
      "merge",
      "removeWorktree",
      "deleteBranch",
    ]);
    expect(readFileSync(join(root, "alpha", "001-rev.md"), "utf8")).toContain(
      "status: done",
    );
    // Resolving is not a spawn — "exactly two spawn edges" holds.
    expect(deps.spawns).toEqual([]);
  });

  it("merges into the PRD feature branch (derived from the PRD dir)", () => {
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam();

    createReactor(root, recordingDeps({ merge })).reconcile();

    // checkout(repo, featureBranch) then merge(repo, branch).
    expect(merge.checkout).toHaveBeenCalledWith("/repos/alpha", "alpha");
    expect(merge.merge).toHaveBeenCalledWith("/repos/alpha", "issue-branch");
  });

  it("does not resolve while auto-run is off", () => {
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam();
    const reactor = createReactor(root, recordingDeps({ merge }));
    reactor.setEnabled(false);

    reactor.reconcile();

    expect(merge.calls).toEqual([]);
    expect(readFileSync(join(root, "alpha", "001-rev.md"), "utf8")).toContain(
      "status: in-review",
    );
  });

  it("is inert when no merge seam is injected", () => {
    // The resolve edge is optional: with no merge seam the verdict-bearing Issue
    // is left in-review (the spawn-edge-wiring tests rely on this).
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const deps = recordingDeps(); // no `merge`

    createReactor(root, deps).reconcile();

    expect(readFileSync(join(root, "alpha", "001-rev.md"), "utf8")).toContain(
      "status: in-review",
    );
  });

  it("leaves the Issue in-review when the merge does not succeed", () => {
    // A non-clean merge (conflict/transient — handled in later slices) leaves the
    // Issue in-review with its verdict; `done` is never written.
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam({
      merge: vi.fn(() => {
        throw new Error("merge conflict");
      }),
    });

    createReactor(root, recordingDeps({ merge })).reconcile();

    const after = readFileSync(join(root, "alpha", "001-rev.md"), "utf8");
    expect(after).toContain("status: in-review");
    expect(after).not.toContain("status: done");
    // No cleanup on a failed merge.
    expect(merge.removeWorktree).not.toHaveBeenCalled();
  });

  it("routes a clean verdict carrying a deviation to human-review (deviation), no merge", () => {
    // Overseer reads the implementor's deviation field itself and routes to
    // human-review with reason `deviation`, folding the note in — no merge. The
    // raw `deviation` field is left intact as the audit trail (ADR 0019).
    writePrd(root, "alpha", {
      "001-rev.md": fm({
        status: "in-review",
        repo: "/repos/alpha",
        worktree: "/wt/issue",
        branch: "issue-branch",
        review_verdict: "clean",
        deviation: "swapped the queue for a poll loop",
      }),
    });
    const merge = fakeMergeSeam();

    createReactor(root, recordingDeps({ merge })).reconcile();

    const after = readFileSync(join(root, "alpha", "001-rev.md"), "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("human_review_reason: deviation");
    expect(after).toContain("swapped the queue for a poll loop");
    // The raw implementor field survives as the audit trail.
    expect(after).toContain("deviation: swapped the queue for a poll loop");
    // No merge ran — the deviation forecloses the clean auto-merge.
    expect(merge.calls).toEqual([]);
  });

  it("escalates a clean verdict whose merge conflicts to human-review (conflict)", () => {
    // End-to-end: a clean-verdict Issue whose merge hits a real conflict (the
    // merge throws and leaves unmerged paths) lands in human-review with reason
    // `conflict` — Overseer aborts the merge and escalates, never auto-resolving.
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam({
      merge: vi.fn(() => {
        throw new Error("CONFLICT (content)");
      }),
      conflictingPaths: vi.fn(() => ["src/x.ts"]),
    });

    createReactor(root, recordingDeps({ merge })).reconcile();

    const after = readFileSync(join(root, "alpha", "001-rev.md"), "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("human_review_reason: conflict");
    expect(after).toContain("src/x.ts"); // the note names what conflicted
    expect(after).not.toContain("status: done");
    // The merge was aborted and the worktree left for the human — no cleanup.
    expect(merge.abortMerge).toHaveBeenCalledWith("/repos/alpha");
    expect(merge.removeWorktree).not.toHaveBeenCalled();
  });

  it("once done, a second reconcile does not re-resolve (done drops it off the frontier)", () => {
    // `writeStatus(done)` is the durable idempotency lock: the Issue leaves the
    // verdict frontier, so an overlapping/later reconcile can't double-act.
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam();
    const reactor = createReactor(root, recordingDeps({ merge }));

    reactor.reconcile();
    expect(merge.merge).toHaveBeenCalledTimes(1);

    reactor.reconcile();
    expect(merge.merge).toHaveBeenCalledTimes(1); // not re-merged
  });

  it("swallows a throw mid-resolve without crashing the board", () => {
    // Totality backstop: a merge-seam method that throws (e.g. the worktree
    // vanished, so the clean check raises) must not escape the watcher callback.
    writePrd(root, "alpha", { "001-rev.md": cleanVerdict() });
    const merge = fakeMergeSeam({
      isWorktreeClean: vi.fn(() => {
        throw new Error("worktree gone");
      }),
    });

    expect(() =>
      createReactor(root, recordingDeps({ merge })).reconcile(),
    ).not.toThrow();
    // The Issue is left in-review for the next reconcile to retry.
    expect(readFileSync(join(root, "alpha", "001-rev.md"), "utf8")).toContain(
      "status: in-review",
    );
  });

  it("resolves a clean verdict while still driving the spawn edges in one pass", () => {
    // The three edges run in one reconcile: an implementor spawns, a reviewer
    // spawns, and a clean verdict resolves to done — independently.
    writePrd(root, "alpha", {
      "001-impl.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
      "002-rev.md": fm({
        status: "ready-for-review",
        repo: "/repos/alpha",
        worktree: "/wt/x",
        branch: "b",
      }),
      "003-resolve.md": cleanVerdict(),
    });
    const merge = fakeMergeSeam();

    createReactor(root, recordingDeps({ merge })).reconcile();

    expect(readFileSync(join(root, "alpha", "001-impl.md"), "utf8")).toContain(
      "status: in-progress",
    );
    expect(readFileSync(join(root, "alpha", "002-rev.md"), "utf8")).toContain(
      "status: in-review",
    );
    expect(readFileSync(join(root, "alpha", "003-resolve.md"), "utf8")).toContain(
      "status: done",
    );
  });
});
