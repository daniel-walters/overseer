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

  it("is a no-op when called re-entrantly (reconcile during reconcile)", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const deps = recordingDeps();
    const reactor = createReactor(root, deps);

    let reentrantSpawns = -1;
    // Re-enter reconcile from inside a spawn; the inner call must be a no-op.
    deps.spawn = (repo, prompt) => {
      deps.spawns.push({ repo, prompt });
      reactor.reconcile(); // re-entrant
      reentrantSpawns = deps.spawns.length;
    };

    reactor.reconcile();

    // The inner reconcile spawned nothing extra (guard held).
    expect(reentrantSpawns).toBe(1);
    expect(deps.spawns).toHaveLength(1);
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
});
