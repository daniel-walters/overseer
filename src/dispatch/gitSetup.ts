import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The git-setup half of the dispatch `spawn` edge: validate each frontier
 * Issue's target `repo` and ensure the per-repo PRD **feature branch** exists,
 * creating it from `origin/main` if absent. Runs once per repo per dispatch,
 * before any agent would spawn, so multiple same-repo Issues don't race on
 * branch creation.
 *
 * All git/filesystem interaction goes through the injectable {@link GitSeam}
 * (mirroring the watcher's `createWatcher` seam), so the orchestration is unit
 * tested without invoking real git. The default seam shells out to `git`.
 */

/** The base ref used when a repo's default branch can't be resolved. */
const ORIGIN_MAIN = "origin/main";

/**
 * The injectable git/fs seam. Each method is a single, narrow git/fs action so
 * a test fake can answer from in-memory state and the real implementation can
 * shell out. Errors thrown by {@link GitSeam.createBranch} are caught and
 * surfaced as a failed {@link RepoSetupResult}.
 */
export interface GitSeam {
  /** Whether `repo` exists on disk and is a real git repository. */
  isGitRepo(repo: string): boolean;
  /**
   * The ref a new feature branch should be created from in `repo` — the repo's
   * own default branch (e.g. `origin/master`), falling back to `origin/main`.
   * Resolved per repo rather than assumed so a repo on `master` or with a
   * non-standard default is still dispatchable.
   */
  defaultBase(repo: string): string;
  /** Whether a local branch named `branch` already exists in `repo`. */
  branchExists(repo: string, branch: string): boolean;
  /** Create `branch` in `repo` from `base` (e.g. `origin/main`). */
  createBranch(repo: string, branch: string, base: string): void;
}

/** The outcome of setting up a single repo for dispatch. */
export type RepoSetupResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Derive the PRD **feature branch** name from the PRD directory name: the
 * slugified directory name. Lowercased, with runs of whitespace and characters
 * unsafe in a git ref folded to single dashes and leading/trailing dashes
 * trimmed, so the branch name is stable and valid across repos.
 */
export function featureBranchName(prdDir: string): string {
  return prdDir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate and prepare every distinct repo touched by a dispatch. For each
 * unique `repo` (in first-seen order), validate it is a local git repo and, if
 * so, ensure the PRD feature branch exists — creating it from the repo's
 * default base when absent, skipping creation when already present (idempotent).
 *
 * De-duplicates by repo so branch-ensure runs once per repo even when several
 * frontier Issues share it: the returned map is keyed by repo, and the caller
 * looks up each Issue's repo to decide whether to spawn or skip-and-report.
 */
export function setUpRepos(
  prdDir: string,
  repos: Iterable<string>,
  git: GitSeam,
): ReadonlyMap<string, RepoSetupResult> {
  const branch = featureBranchName(prdDir);
  const results = new Map<string, RepoSetupResult>();

  for (const repo of repos) {
    if (results.has(repo)) continue; // already set this repo up this dispatch
    results.set(repo, setUpRepo(repo, branch, git));
  }

  return results;
}

/** Validate one repo and ensure its feature branch. Never throws. */
function setUpRepo(
  repo: string,
  branch: string,
  git: GitSeam,
): RepoSetupResult {
  if (!git.isGitRepo(repo)) {
    return { ok: false, error: `${repo} is not a valid git repo` };
  }

  try {
    if (!git.branchExists(repo, branch)) {
      git.createBranch(repo, branch, git.defaultBase(repo));
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }

  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The real git/fs seam used in production: probes the filesystem and shells out
 * to `git` with `-C <repo>`. Construction-free — a plain object so callers can
 * pass it straight to {@link setUpRepos}.
 */
export const realGitSeam: GitSeam = {
  isGitRepo(repo: string): boolean {
    if (!existsSync(repo)) return false;
    try {
      execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  },

  defaultBase(repo: string): string {
    // `origin/HEAD` points at the remote's default branch, e.g.
    // `refs/remotes/origin/master`. Strip the prefix to get `origin/master`.
    try {
      const ref = execFileSync(
        "git",
        ["-C", repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        { encoding: "utf8" },
      ).trim();
      const base = ref.replace(/^refs\/remotes\//, "");
      if (base) return base;
    } catch {
      // origin/HEAD not set (no remote, or never fetched) — fall through.
    }
    return ORIGIN_MAIN;
  },

  branchExists(repo: string, branch: string): boolean {
    try {
      execFileSync(
        "git",
        ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  },

  createBranch(repo: string, branch: string, base: string): void {
    execFileSync("git", ["-C", repo, "branch", branch, base], {
      stdio: "ignore",
    });
  },
};
