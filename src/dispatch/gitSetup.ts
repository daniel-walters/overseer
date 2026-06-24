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

/**
 * One Issue's merge as the {@link StackGitSeam} reads it off the feature branch's
 * own history: the implementor branch that was `merge --no-ff`'d (recovered from
 * the default merge message, `Merge branch '<branch>' …`) and the work commit(s)
 * that merge contributed (the merge's second-parent history), oldest-first. The
 * recorded `branch:` field on each Issue joins this back to the Issue, so the
 * materializer can group merges by slice without anything being stored beyond the
 * `slice:`/`branch:` frontmatter the implementor and to-issues already write.
 */
export interface MergeRecord {
  /** The implementor branch this merge brought in, from the merge message. */
  readonly branch: string;
  /** The work commits the merge contributed, oldest-first (to replay). */
  readonly workCommits: readonly string[];
}

/**
 * The git seam the stack materializer drives to cut per-slice branches from the
 * feature branch's merge history (CONTEXT.md → Stacked output, ADR 0024). Kept
 * separate from {@link GitSeam} (which dispatch uses): a test fake answers from
 * in-memory state and records the cuts, the {@link realStackGitSeam} shells out.
 *
 * The cut is a *replay*, not a truncation: a naive "branch the feature at slice
 * N's last merge commit" leaks a later-but-earlier-merged slice's work into an
 * earlier slice for an interleaved history. So the seam exposes the merge records
 * (resolved to Issues by branch), and the materializer cherry-picks only each
 * slice's own work onto the prior slice — reconstructing a clean per-slice diff.
 */
export interface StackGitSeam {
  /**
   * Walk `featureBranch`'s first-parent merge history down to `base` and return
   * each Issue merge — its source branch and the work commits it contributed —
   * oldest-first. The order is the feature-history order a faithful replay keeps.
   */
  stackMergeRecords(
    repo: string,
    featureBranch: string,
    base: string,
  ): readonly MergeRecord[];
  /** Create `branch` in `repo` at `startPoint` (a slice's base) without checking it out into a worktree-affecting state beyond HEAD. */
  createBranchAt(repo: string, branch: string, startPoint: string): void;
  /**
   * Cherry-pick `commits` (oldest-first) onto `branch`, replaying one slice's
   * work onto the branch just cut from its base. Throws on a conflict or any git
   * failure so the materializer surfaces it loudly (it should never conflict for
   * a clean cut, by the no-forward-dependency invariant — ADR 0024).
   */
  cherryPick(repo: string, branch: string, commits: readonly string[]): void;
  /** Check out `branch` in `repo`, restoring HEAD to a known branch. */
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

/**
 * Derive a per-slice branch name for a stacked Open PR (CONTEXT.md → Stacked
 * output, ADR 0024): the PRD feature branch with the slice's `N-name` label
 * appended after a `-slice-` segment, e.g. `stacked-prs-slice-2-api`. Slugged the
 * same way as {@link featureBranchName} so the label's number and name fold to a
 * stable, valid git ref, and derived purely from the feature branch + label so
 * the Linked PR overlay (ADR 0025) can re-derive the very same names from the
 * `slice:` fields without anything being stored.
 *
 * The `-slice-` infix is deliberately a **flat** sibling of the feature branch,
 * not a `<feature>/slice/...` path: git refs are files under `.git/refs/heads`,
 * so a branch named `<feature>/slice/...` would need `<feature>` to be a
 * directory while the feature branch itself is a file of that name — git rejects
 * the collision ("cannot lock ref"). A flat name avoids it entirely.
 */
export function sliceBranchName(featureBranch: string, sliceLabel: string): string {
  const slug = sliceLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${featureBranch}-slice-${slug || asciiFallbackHash(sliceLabel)}`;
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

/** Matches git's default `--no-ff` merge-commit subject to recover the source branch. */
const MERGE_SUBJECT = /^Merge branch '([^']+)'/i;
/** Cap on captured `git log` stdout when reading the merge history (fail-safe). */
const STACK_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The real {@link StackGitSeam}: shells out to `git -C <repo>` to read the feature
 * branch's merge history and to cut + replay the slice branches. The un-fakeable
 * shell-out boundary, kept thin and excluded from unit tests exactly as
 * {@link realGitSeam} is; the testable logic lives in {@link planStackCut} and the
 * materializer, driven by an in-memory fake.
 */
export const realStackGitSeam: StackGitSeam = {
  stackMergeRecords(
    repo: string,
    featureBranch: string,
    base: string,
  ): readonly MergeRecord[] {
    // Walk the feature branch's own first-parent merges down to the base,
    // oldest-first (the feature-history order a faithful replay keeps). Each line
    // is `<merge-sha>\t<subject>`; the subject is git's default merge message,
    // `Merge branch '<branch>' …`, from which we recover the merged branch.
    const out = execFileSync(
      "git",
      [
        "-C",
        repo,
        "log",
        "--first-parent",
        "--merges",
        "--reverse",
        "--format=%H%x09%s",
        `${base}..${featureBranch}`,
      ],
      { encoding: "utf8", maxBuffer: STACK_MAX_BUFFER },
    );

    const records: MergeRecord[] = [];
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const merge = line.slice(0, tab);
      const subject = line.slice(tab + 1);
      const branchMatch = MERGE_SUBJECT.exec(subject);
      if (!branchMatch) continue; // not a recognisable Issue merge — skip it
      const branch = branchMatch[1]!;
      // The merge's work commits are exactly the commits on the merged branch:
      // `merge^1..merge^2`, oldest-first, so the cherry-pick replays them in order.
      const work = execFileSync(
        "git",
        ["-C", repo, "rev-list", "--reverse", `${merge}^1..${merge}^2`],
        { encoding: "utf8", maxBuffer: STACK_MAX_BUFFER },
      )
        .split("\n")
        .filter((sha) => sha.trim() !== "");
      records.push({ branch, workCommits: work });
    }
    return records;
  },

  createBranchAt(repo: string, branch: string, startPoint: string): void {
    // Create and check out the slice branch at its base, so the subsequent
    // cherry-pick replays onto it. Bottom-up cutting means each base (the prior
    // slice's branch) already exists when this runs.
    // On retry after a partial failure the branch may already exist locally;
    // use `git checkout` (not `-b`) in that case so the seam is idempotent.
    try {
      execFileSync(
        "git",
        ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { stdio: "ignore" },
      );
      // Branch exists — just check it out (don't re-create it).
      execFileSync("git", ["-C", repo, "checkout", branch], { stdio: "ignore" });
    } catch {
      // Branch doesn't exist — create it at the start point.
      execFileSync("git", ["-C", repo, "checkout", "-b", branch, startPoint], {
        stdio: "ignore",
      });
    }
  },

  cherryPick(repo: string, branch: string, commits: readonly string[]): void {
    if (commits.length === 0) return;
    // The branch was just checked out by createBranchAt; replay its slice's work.
    // A failure (a conflict — which the no-forward-dependency invariant should
    // preclude — or any git error) throws, and the materializer surfaces it.
    execFileSync("git", ["-C", repo, "cherry-pick", ...commits], {
      stdio: ["ignore", "pipe", "inherit"],
    });
  },

  checkoutBranch(repo: string, branch: string): void {
    execFileSync("git", ["-C", repo, "checkout", branch], { stdio: "ignore" });
  },
};
