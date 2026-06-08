import { describe, it, expect, vi } from "vitest";
import {
  featureBranchName,
  setUpRepos,
  type GitSeam,
} from "./gitSetup.js";

/**
 * A scriptable stand-in for the real git/fs seam, mirroring the watcher test's
 * `FakeWatcher`. Records every call and answers from in-memory state so we can
 * assert validation gating and idempotent branch-ensure with no real git.
 */
class FakeGit implements GitSeam {
  /** Repos the fake treats as valid local git repos. */
  readonly validRepos = new Set<string>();
  /** `repo` → set of branch names that already exist there. */
  readonly branches = new Map<string, Set<string>>();
  /** Repos whose `createBranch` should throw, simulating a git failure. */
  readonly failCreate = new Set<string>();
  /** `repo` → its resolved default base ref; absent ⇒ falls back to origin/main. */
  readonly bases = new Map<string, string>();

  readonly isGitRepo = vi.fn((repo: string) => this.validRepos.has(repo));
  readonly defaultBase = vi.fn(
    (repo: string) => this.bases.get(repo) ?? "origin/main",
  );
  readonly branchExists = vi.fn(
    (repo: string, branch: string) =>
      this.branches.get(repo)?.has(branch) ?? false,
  );
  readonly createBranch = vi.fn((repo: string, branch: string) => {
    if (this.failCreate.has(repo)) {
      throw new Error(`git branch failed in ${repo}`);
    }
    let set = this.branches.get(repo);
    if (!set) {
      set = new Set();
      this.branches.set(repo, set);
    }
    set.add(branch);
  });

  /** Register a repo as a valid git repo with the given existing branches. */
  addRepo(repo: string, branches: string[] = []): void {
    this.validRepos.add(repo);
    this.branches.set(repo, new Set(branches));
  }
}

describe("featureBranchName", () => {
  it("is the slugified PRD directory name", () => {
    expect(featureBranchName("auth-system")).toBe("auth-system");
  });

  it("lowercases and replaces whitespace and unsafe characters with dashes", () => {
    expect(featureBranchName("Auth System!")).toBe("auth-system");
  });

  it("collapses runs of separators and trims leading/trailing dashes", () => {
    expect(featureBranchName("  Payment   Intent / v2  ")).toBe(
      "payment-intent-v2",
    );
  });
});

describe("setUpRepos", () => {
  const PRD = "auth-system";
  const BRANCH = "auth-system";

  it("passes a valid local git repo and fails a missing/non-git repo", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api", [BRANCH]);
    // "/repos/web" is not registered → not a git repo.

    const result = setUpRepos(PRD, ["/repos/api", "/repos/web"], git);

    expect(result.get("/repos/api")).toEqual({ ok: true });
    const web = result.get("/repos/web");
    expect(web?.ok).toBe(false);
    if (web && !web.ok) {
      expect(web.error).toMatch(/not a (valid )?git repo/i);
    }
  });

  it("creates the feature branch from the repo's default base when absent", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api"); // valid repo, no branches yet; default base ⇒ origin/main

    const result = setUpRepos(PRD, ["/repos/api"], git);

    expect(result.get("/repos/api")).toEqual({ ok: true });
    expect(git.createBranch).toHaveBeenCalledWith(
      "/repos/api",
      BRANCH,
      "origin/main",
    );
  });

  it("creates from a non-main default base (e.g. a repo on master)", () => {
    const git = new FakeGit();
    git.addRepo("/repos/legacy");
    git.bases.set("/repos/legacy", "origin/master");

    const result = setUpRepos(PRD, ["/repos/legacy"], git);

    expect(result.get("/repos/legacy")).toEqual({ ok: true });
    expect(git.createBranch).toHaveBeenCalledWith(
      "/repos/legacy",
      BRANCH,
      "origin/master",
    );
  });

  it("skips creation when the feature branch already exists (idempotent)", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api", [BRANCH]);

    setUpRepos(PRD, ["/repos/api"], git);

    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("ensures the branch once per repo even when many Issues share it", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api"); // absent branch

    // Three frontier Issues all target the same repo.
    setUpRepos(PRD, ["/repos/api", "/repos/api", "/repos/api"], git);

    expect(git.isGitRepo).toHaveBeenCalledTimes(1);
    expect(git.branchExists).toHaveBeenCalledTimes(1);
    expect(git.createBranch).toHaveBeenCalledTimes(1);
  });

  it("does not attempt branch-ensure on a repo that fails validation", () => {
    const git = new FakeGit(); // "/repos/web" not registered

    const result = setUpRepos(PRD, ["/repos/web"], git);

    expect(result.get("/repos/web")?.ok).toBe(false);
    expect(git.branchExists).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("surfaces a branch-creation failure as a failed result for that repo", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api"); // valid, branch absent
    git.failCreate.add("/repos/api");

    const result = setUpRepos(PRD, ["/repos/api"], git);

    const api = result.get("/repos/api");
    expect(api?.ok).toBe(false);
    if (api && !api.ok) {
      expect(api.error).toMatch(/git branch failed/i);
    }
  });

  it("reports per-repo results independently across a mixed set", () => {
    const git = new FakeGit();
    git.addRepo("/repos/api"); // valid, will create branch
    git.addRepo("/repos/frontend", [BRANCH]); // valid, branch present
    // "/repos/missing" not registered → invalid.

    const result = setUpRepos(
      PRD,
      ["/repos/api", "/repos/frontend", "/repos/missing"],
      git,
    );

    expect(result.get("/repos/api")).toEqual({ ok: true });
    expect(result.get("/repos/frontend")).toEqual({ ok: true });
    expect(result.get("/repos/missing")?.ok).toBe(false);
    expect(git.createBranch).toHaveBeenCalledTimes(1);
    expect(git.createBranch).toHaveBeenCalledWith(
      "/repos/api",
      BRANCH,
      "origin/main",
    );
  });
});
