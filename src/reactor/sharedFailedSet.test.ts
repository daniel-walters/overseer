import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactor, type ReactorDeps } from "./reactor.js";
import { createFailedSet } from "./failedSet.js";
import { createDispatcher, type DispatcherDeps } from "../dispatch/dispatcher.js";
import { createReviewer, type ReviewerDeps } from "../review/reviewer.js";
import { DEFAULT_REVIEW_CONFIG } from "../review/reviewConfig.js";
import type { GitSeam } from "../dispatch/gitSetup.js";

/** A git seam that treats every repo as valid with the branch already present. */
function fakeGit(): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => "origin/main"),
    branchExists: vi.fn(() => true),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
  };
}

const fm = (fields: Record<string, string>, body = "body"): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

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

/**
 * The behaviour change this slice exists for (ADR 0011): one failed-set instance
 * is shared across all three spawn triggers, so a launch failure on a *manual*
 * `d`/`r` edge is recorded into — and subtracted from — the same set the Reactor
 * reads. A failed launch is a failed launch regardless of who triggered it, so
 * the Reactor must not re-spawn an Issue whose manual launch just failed.
 */
describe("shared failed-set across spawn edges", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-shared-failed-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function reactorDeps(
    failedSet: ReturnType<typeof createFailedSet>,
    spawn: ReactorDeps["spawn"],
  ): ReactorDeps & { spawns: { repo: string; prompt: string }[] } {
    const spawns: { repo: string; prompt: string }[] = [];
    return {
      spawns,
      git: fakeGit(),
      spawn: (repo, prompt) => {
        spawns.push({ repo, prompt });
        return spawn(repo, prompt);
      },
      logFailure: () => {},
      recordHandle: () => {},
      failedSet,
    };
  }

  function dispatcherDeps(
    failedSet: ReturnType<typeof createFailedSet>,
    spawn: DispatcherDeps["spawn"],
  ): DispatcherDeps {
    return {
      git: fakeGit(),
      spawn,
      logFailure: () => {},
      recordHandle: () => {},
      failedSet,
    };
  }

  function reviewerDeps(
    failedSet: ReturnType<typeof createFailedSet>,
    spawn: ReviewerDeps["spawn"],
  ): ReviewerDeps {
    return {
      spawn,
      logFailure: () => {},
      recordHandle: () => {},
      readReviewPass: () => undefined,
      failedSet,
      review: DEFAULT_REVIEW_CONFIG,
    };
  }

  it("a failed manual d launch is subtracted from the next Reactor reconcile", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const failedSet = createFailedSet();

    // The manual `d` dispatch launch throws (bad binary / git hiccup): it rolls
    // the Issue back to ready-for-agent and records (path, implementor) into the
    // shared set.
    const dispatcher = createDispatcher(
      root,
      dispatcherDeps(failedSet, () => {
        throw new Error("claude: command not found");
      }),
    );
    dispatcher.dispatch(dispatcher.readFrontier("alpha"));

    const file = join(root, "alpha", "001-go.md");
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-agent");
    expect(failedSet.has(file, "implementor")).toBe(true);

    // The Reactor shares that same set. Even though the Issue is still
    // ready-for-agent on disk (so the frontier would re-pick it), the Reactor
    // subtracts the failed-set and does not re-spawn it this session.
    const deps = reactorDeps(failedSet, () => "handle");
    createReactor(root, deps).reconcile();

    expect(deps.spawns).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-agent");
  });

  it("a failed manual r launch is subtracted from the next Reactor reconcile", () => {
    writePrd(root, "alpha", {
      "001-rev.md": fm({
        status: "ready-for-review",
        repo: "/repos/alpha",
        worktree: "/wt/issue",
        branch: "issue-branch",
      }),
    });

    const failedSet = createFailedSet();

    const reviewer = createReviewer(
      root,
      reviewerDeps(failedSet, () => {
        throw new Error("claude: command not found");
      }),
    );
    const preview = reviewer.readReview("alpha", "001-rev.md");
    if (!preview) throw new Error("expected a preview");
    reviewer.review(preview);

    const file = join(root, "alpha", "001-rev.md");
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-review");
    expect(failedSet.has(file, "reviewer")).toBe(true);

    // The Reactor, sharing the set, does not re-spawn the reviewer this session.
    const deps = reactorDeps(failedSet, () => "handle");
    createReactor(root, deps).reconcile();

    expect(deps.spawns).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-review");
  });

  it("a failed manual d does not suppress the reviewer edge for the same Issue", () => {
    // The set is keyed by (path, edge): a manual `d` failure records only the
    // implementor edge, so a later reviewer spawn on that Issue is untouched.
    writePrd(root, "alpha", {
      "001.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });

    const failedSet = createFailedSet();
    const dispatcher = createDispatcher(
      root,
      dispatcherDeps(failedSet, () => {
        throw new Error("impl launch failed");
      }),
    );
    dispatcher.dispatch(dispatcher.readFrontier("alpha"));

    const file = join(root, "alpha", "001.md");
    expect(failedSet.has(file, "implementor")).toBe(true);
    expect(failedSet.has(file, "reviewer")).toBe(false);

    // The Issue advances to ready-for-review; the Reactor's reviewer edge is a
    // different key, so it still spawns.
    writeFileSync(
      file,
      fm({
        status: "ready-for-review",
        repo: "/repos/alpha",
        worktree: "/wt/x",
        branch: "b",
      }),
    );
    const deps = reactorDeps(failedSet, () => "handle");
    createReactor(root, deps).reconcile();
    expect(deps.spawns).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toContain("status: in-review");
  });

  it("the set is full-path keyed: a manual d failure in one PRD spares a same-named Issue in another", () => {
    writePrd(root, "alpha", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/alpha" }),
    });
    writePrd(root, "beta", {
      "001-go.md": fm({ status: "ready-for-agent", repo: "/repos/beta" }),
    });

    const failedSet = createFailedSet();

    // A manual `d` on alpha's 001-go.md fails.
    const dispatcher = createDispatcher(
      root,
      dispatcherDeps(failedSet, () => {
        throw new Error("alpha broken");
      }),
    );
    dispatcher.dispatch(dispatcher.readFrontier("alpha"));
    expect(failedSet.has(join(root, "alpha", "001-go.md"), "implementor")).toBe(
      true,
    );

    // The Reactor still dispatches beta's distinct same-named Issue; only alpha's
    // is suppressed.
    const deps = reactorDeps(failedSet, () => "handle");
    createReactor(root, deps).reconcile();
    expect(deps.spawns.map((s) => s.repo)).toEqual(["/repos/beta"]);
    expect(readFileSync(join(root, "alpha", "001-go.md"), "utf8")).toContain(
      "status: ready-for-agent",
    );
    expect(readFileSync(join(root, "beta", "001-go.md"), "utf8")).toContain(
      "status: in-progress",
    );
  });
});
