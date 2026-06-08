import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "../errorMessage.js";

/**
 * The git-setup half of the dispatch `spawn` edge: validate each frontier
 * Issue's target `repo`, ensure the per-repo PRD **feature branch** exists
 * (creating it from `origin/main` if absent), and check it out so the agent's
 * worktree branches from it. Runs once per repo per dispatch, before any agent
 * would spawn, so multiple same-repo Issues don't race on branch setup.
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
 * shell out. Errors thrown by {@link GitSeam.createBranch} /
 * {@link GitSeam.checkoutBranch} are caught and surfaced as a failed
 * {@link RepoSetupResult}.
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
  /**
   * Check out `branch` in `repo` so it is the repo's current HEAD. A dispatched
   * agent's worktree (`claude --bg` branches off the repo's current HEAD) must
   * start from the feature branch; without this the branch is created but never
   * used and agents build on whatever was previously checked out.
   */
  checkoutBranch(repo: string, branch: string): void;
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
 *
 * Names that slug to nothing (all-punctuation or all-non-ASCII, e.g. a CJK
 * feature name) would otherwise yield `""`, and `git branch ""` is rejected —
 * silently making the whole PRD undispatchable. Such names fall back to a
 * hashed `prd-<hex>` slug so they remain valid, stable, and distinct.
 */
export function featureBranchName(prdDir: string): string {
  const slug = prdDir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `prd-${asciiFallbackHash(prdDir)}`;
}

/** A short, stable hex hash of a name with no ASCII alphanumerics to slug. */
function asciiFallbackHash(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash.toString(16);
}

/**
 * Validate and prepare every distinct repo touched by a dispatch. For each
 * unique `repo` (in first-seen order), validate it is a local git repo and, if
 * so, ensure the PRD feature branch exists — creating it from the repo's
 * default base when absent, skipping creation when already present (idempotent).
 *
 * De-duplicates by *normalized* repo path so branch-ensure runs once per repo
 * even when several frontier Issues share it — including when they spell the
 * same repo differently (`/repos/api` vs `/repos/api/`). The returned map is
 * keyed by the original repo string each distinct repo was first seen as, and
 * the caller looks up each Issue's repo to decide whether to spawn or
 * skip-and-report; sibling spellings resolve to the same cached result.
 */
export function setUpRepos(
  branchName: string,
  repos: Iterable<string>,
  git: GitSeam,
): ReadonlyMap<string, RepoSetupResult> {
  const results = new Map<string, RepoSetupResult>();
  /** normalized path → the result computed for it, shared across spellings. */
  const byNormalized = new Map<string, RepoSetupResult>();

  for (const repo of repos) {
    if (results.has(repo)) continue; // this exact spelling already mapped
    const key = normalizeRepo(repo);
    let result = byNormalized.get(key);
    if (result === undefined) {
      result = setUpRepo(repo, branchName, git);
      byNormalized.set(key, result);
    }
    results.set(repo, result);
  }

  return results;
}

/** Canonical key for a repo path, folding trailing-slash/`.`-segment variants. */
function normalizeRepo(repo: string): string {
  return resolve(repo);
}

/**
 * Validate one repo, ensure its feature branch exists, and check it out so the
 * dispatched agent's worktree branches from it. Never throws.
 */
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
    git.checkoutBranch(repo, branch);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }

  return { ok: true };
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

  checkoutBranch(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "checkout", branch], {
      stdio: "ignore",
    });
  },
};
