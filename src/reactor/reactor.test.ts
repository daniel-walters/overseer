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

/** A git seam that treats every repo as valid with the branch already present. */
function fakeGit(overrides: Partial<GitSeam> = {}): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => "origin/main"),
    branchExists: vi.fn(() => true),
    currentBranch: vi.fn(() => undefined),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
    ...overrides,
  };
}

/** Recording seams so we can assert which spawns happened and which failed. */
function recordingDeps(overrides: Partial<ReactorDeps> = {}): ReactorDeps & {
  spawns: { repo: string; prompt: string }[];
  failures: unknown[];
} {
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: unknown[] = [];
  return {
    spawns,
    failures,
    git: fakeGit(),
    spawn: (repo, prompt) => spawns.push({ repo, prompt }),
    logFailure: (r) => failures.push(r),
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

  it("isolates an unexpected throw in one PRD's spawn edge, still serving the others", () => {
    // The spawn edges are built total, but the watcher callback is unguarded, so
    // the Reactor wraps each PRD in a per-PRD boundary as a backstop. Simulate a
    // throw the edge does NOT catch (git.isGitRepo runs before setUpRepo's
    // try/catch): alpha's repo probe blows up, beta's is fine. alpha is skipped,
    // beta still dispatches, and nothing escapes to crash the board.
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    writePrd(root, "beta", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/beta" }),
    });
    const deps = recordingDeps({
      git: fakeGit({
        isGitRepo: vi.fn((repo: string) => {
          if (repo === "/repos/alpha") throw new Error("git exploded");
          return true;
        }),
      }),
    });

    expect(() => createReactor(root, deps).reconcile()).not.toThrow();
    // beta still spawned; alpha's throwing PRD was skipped, not fatal.
    expect(deps.spawns.map((s) => s.repo)).toEqual(["/repos/beta"]);
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

  it("builds a reviewer prompt carrying the worktree and branch to merge", () => {
    writePrd(root, "alpha", { "001-rev.md": reviewable("/repos/alpha") });

    const deps = recordingDeps();
    createReactor(root, deps).reconcile();

    const prompt = deps.spawns[0]?.prompt ?? "";
    expect(prompt).toContain("/wt/issue"); // recorded worktree
    expect(prompt).toContain("issue-branch"); // recorded branch
    expect(prompt).toContain("alpha"); // PRD feature branch
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
});
