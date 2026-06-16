import { basename, join } from "node:path";
import { featureBranchName, realGitSeam, type GitSeam } from "./gitSetup.js";
import { realPrSeam, realReadRepos, type PrSeam } from "./linkedPr.js";
import { errorMessage } from "../errorMessage.js";
import type { OpenPr } from "../ui/App.js";

/**
 * Open PR: the `done`-gated, confirm-previewed, human-only board action that
 * pushes a finished PRD's feature branch and opens a GitHub PR from it into the
 * repo's resolved default base (CONTEXT.md, the parent PRD). The board's first
 * outward GitHub writes — every other surface is read-only.
 *
 * This module is the deep module behind that action: given a `done` PRD's
 * directory it resolves the PRD's single repo (refusing a multi-repo or repo-less
 * PRD — the single-repo guard), refuses a branch that already has a PR (open or
 * merged, so it can never open a duplicate), resolves the base via the same
 * `gitSetup` `defaultBase` the feature branch was created from, then pushes the
 * branch and creates the PR. Every external edge goes through the injectable
 * {@link PrSeam} (push/create/query) + {@link GitSeam} (defaultBase), so the whole
 * orchestration is unit-tested with in-memory fakes and no real `git`/`gh` —
 * mirroring {@link import("./gitSetup.js").setUpRepos}'s `GitSeam` orchestration.
 *
 * Total by construction: a multi-repo / repo-less / already-PR'd PRD, a thrown
 * repo read (the watched root deleting the PRD mid-action), and a `git push` /
 * `gh pr create` failure (no auth, network, non-GitHub remote) all resolve to a
 * failed {@link OpenPrResult} carrying a human-readable reason — never a throw out
 * of the Ink input handler, so a failure surfaces loudly in the status line
 * rather than crashing the board.
 */

/**
 * The frozen plan an Open PR confirm acts on, and what the confirm modal renders
 * ({@link import("../ui/OpenPrPreview.js").OpenPrPreview}). Built by
 * {@link createOpenPr.readOpenPr} when `P` is pressed on a `done` PRD, captured
 * outside the App's nav reducer so a live re-scan under the modal can't re-point
 * it at another PRD (mirroring the dispatch / review preview captures).
 *
 * `eligibility` carries the single-repo guard and the existing-PR guard up to the
 * modal: a refused PRD (>1 repo, or a branch that already has a PR) shows *why* it
 * can't open and offers only a dismiss — so the refusal is a visible message,
 * never a silent no-op or crash. It is domain data (resolved branch / base /
 * refusal), so it lives here beside the orchestration rather than in the UI.
 */
export interface OpenPrPreviewData {
  /** The PRD being PR'd, named so the user can catch a wrong target. */
  readonly prdTitle: string;
  /** The derived feature branch that will be pushed and PR'd. */
  readonly branch: string;
  /** The resolved default base the PR opens into (not a hardcoded `main`). */
  readonly base: string;
  /** Whether the action can proceed, or why it is refused. */
  readonly eligibility:
    | { readonly canOpen: true }
    | { readonly canOpen: false; readonly reason: string };
}

/** The seams + per-PRD repo read the Open PR orchestration depends on. */
export interface OpenPrDeps {
  /** Push a branch, create a PR, and query for an existing one (default: `gh`/`git`). */
  readonly prSeam: PrSeam;
  /** Resolve the repo's default base — the PR target (default: real `git`). */
  readonly git: GitSeam;
  /**
   * The distinct `repo:` values across the PRD's Issues, in first-seen order — the
   * single-repo guard's input. A v1 PR targets exactly one repo, so the action
   * refuses unless this yields exactly one. The default reads each Issue's
   * frontmatter (the same read the Linked PR overlay uses); a test fake answers
   * from in-memory state.
   */
  readonly readRepos: (prdDir: string) => readonly string[];
}

/**
 * The outcome of an Open PR action: the created PR's `url` on success, or a
 * human-readable `error` the App surfaces loudly in the status line. Mirrors the
 * `GitSeam`'s {@link import("./gitSetup.js").RepoSetupResult} shape so the two
 * outward-action results read the same.
 */
export type OpenPrResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/**
 * Run the Open PR action for one `done` PRD's directory. Resolve the single repo,
 * refuse a multi-repo / repo-less / already-PR'd PRD, resolve the base, then push
 * the derived feature branch and create the PR. Never throws — every refusal and
 * every `git`/`gh` failure comes back as a failed {@link OpenPrResult}.
 *
 * The caller (the App) gates this to `done` PRDs; this function does not re-check
 * the column (it has only the directory), so an off-`done` no-op is the App's
 * concern, exactly as `d`/`r` gate their level before calling the dispatcher.
 */
export function openPrFor(prdDir: string, deps: OpenPrDeps): OpenPrResult {
  let repos: readonly string[];
  try {
    repos = deps.readRepos(prdDir);
  } catch (err) {
    // The PRD vanished mid-action (the watched root deleted it). Refuse rather
    // than crash the input handler.
    return { ok: false, error: errorMessage(err) };
  }

  // The single-repo guard: a v1 PR targets exactly one repo. A multi-repo PRD has
  // a per-repo feature branch (no single PR to open — the deferred follow-up), and
  // a repo-less PRD has nothing to push. Either way refuse with a visible message.
  const [repo, ...rest] = repos;
  if (repo === undefined) {
    return { ok: false, error: "this PRD names no repo to open a PR in" };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      error: `this PRD spans ${repos.length} repos — open a PR per repo manually`,
    };
  }

  const branch = featureBranchName(basename(prdDir));

  try {
    // Refuse if a PR already exists for the branch (open or merged) — never open a
    // duplicate. Reuses the read path's query; a `gh` failure here resolves to
    // *no PR* (undefined), so a degraded query doesn't block the action — the
    // push/create below would then surface the same failure loudly.
    if (deps.prSeam.query(repo, branch) !== undefined) {
      return {
        ok: false,
        error: `a PR already exists for ${branch} — not opening a duplicate`,
      };
    }

    // Push before create: the feature branch normally only ever lived locally
    // (review merges into it locally, nothing pushes it), so `gh pr create` would
    // fail on a missing remote branch without this. A push failure throws and is
    // caught below — no PR is created.
    deps.prSeam.push(repo, branch);

    // Open the PR into the repo's *resolved* default base — the same base the
    // feature branch was created from (gitSetup.defaultBase), not a hardcoded main.
    const url = deps.prSeam.create(repo, branch, prBase(deps.git.defaultBase(repo)));
    return { ok: true, url };
  } catch (err) {
    // A `git push` / `gh pr create` failure (no auth, network, non-GitHub remote)
    // surfaces loudly in the status line, like a spawn failure — never a crash.
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Resolve a `done` PRD's directory into the Open PR eligibility the preview
 * carries: the single repo + derived branch + resolved base, or a refusal reason
 * (multi-repo / repo-less / existing PR). Pure given the seams. Shared by
 * {@link createOpenPr}'s `readOpenPr`; the confirm path re-validates via
 * {@link openPrFor} (defense in depth — the board can change under the modal).
 */
function resolveEligibility(
  prdDir: string,
  deps: OpenPrDeps,
): OpenPrPreviewData {
  const prdTitle = basename(prdDir);
  const branch = featureBranchName(prdTitle);

  const repos = deps.readRepos(prdDir);
  const [repo, ...rest] = repos;
  if (repo === undefined) {
    return refused(prdTitle, branch, "", "this PRD names no repo to open a PR in");
  }
  if (rest.length > 0) {
    return refused(
      prdTitle,
      branch,
      "",
      `this PRD spans ${repos.length} repos — open a PR per repo manually`,
    );
  }

  const base = prBase(deps.git.defaultBase(repo));
  if (deps.prSeam.query(repo, branch) !== undefined) {
    return refused(
      prdTitle,
      branch,
      base,
      `a PR already exists for ${branch} — not opening a duplicate`,
    );
  }

  return { prdTitle, branch, base, eligibility: { canOpen: true } };
}

/**
 * The PR base branch name `gh pr create --base` wants, from the ref
 * `gitSetup.defaultBase` resolves. `defaultBase` returns a *remote-tracking* ref
 * (`origin/master` / `origin/main`) — the right form for `git branch <name>
 * <base>` (a revision), which is what dispatch uses it for. But `gh pr create
 * --base` takes a **branch name on the base repo** (`master`), and rejects
 * `origin/master` ("could not find branch"). Strip the leading `origin/` remote
 * segment so the PR targets the actual default branch, and so the preview shows
 * the same branch name the PR opens into.
 */
function prBase(defaultBase: string): string {
  return defaultBase.replace(/^origin\//, "");
}

/** A refused {@link OpenPrPreviewData} carrying its visible reason. */
function refused(
  prdTitle: string,
  branch: string,
  base: string,
  reason: string,
): OpenPrPreviewData {
  return { prdTitle, branch, base, eligibility: { canOpen: false, reason } };
}

/**
 * Build the App-facing {@link OpenPr} seam bound to a watched `root` and the given
 * seams. `readOpenPr` joins `root` + the PRD id to its directory and resolves the
 * preview's eligibility (the single-repo / existing-PR guards surface here so the
 * modal shows the refusal before a confirm); `openPr` runs {@link openPrFor} over
 * the PRD on confirm.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI, so `P` and confirm can race a deletion. `readOpenPr` reports a vanished
 * PRD as no preview (nothing opens), and `openPr` reports any failure as a failed
 * {@link OpenPrResult} — neither throws out of the Ink input handler.
 */
export function createOpenPr(root: string, deps: OpenPrDeps): OpenPr {
  return {
    readOpenPr(prdId: string): OpenPrPreviewData | undefined {
      const prdDir = join(root, prdId);
      try {
        return resolveEligibility(prdDir, deps);
      } catch {
        return undefined; // PRD dir/files vanished from the watched root
      }
    },

    openPr(preview: OpenPrPreviewData): OpenPrResult {
      // A refused preview never reaches here from the App (the confirm is a no-op
      // for `canOpen: false`), but guard anyway so the seam is correct in isolation.
      if (!preview.eligibility.canOpen) {
        return { ok: false, error: preview.eligibility.reason };
      }
      return openPrFor(join(root, preview.prdTitle), deps);
    },
  };
}

/**
 * Build the production Open PR dependencies wired to the real `git`/`gh` seam and
 * the real per-PRD repo read — the ones the CLI passes through to the App. A thin
 * convenience so the wiring site need not name all three default seams, mirroring
 * {@link import("./linkedPr.js").realLinkedPrLookup}.
 */
export function realOpenPrDeps(): OpenPrDeps {
  return { prSeam: realPrSeam, git: realGitSeam, readRepos: realReadRepos };
}
