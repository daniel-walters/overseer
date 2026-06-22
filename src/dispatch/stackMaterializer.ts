import { basename } from "node:path";
import {
  featureBranchName,
  type MergeRecord,
  type StackGitSeam,
} from "./gitSetup.js";
import type { PrSeam } from "./linkedPr.js";
import { planStackCut, type IssueMerge, type SliceBranchPlan } from "./stackCutPlanner.js";
import { readDispatchView } from "./reader.js";
import { errorMessage } from "../errorMessage.js";

/**
 * The stack materializer: the impure shell over the pure {@link planStackCut}
 * (CONTEXT.md → Stacked output, ADR 0024). On a `done` PRD whose Issues carry ≥2
 * distinct `slice:` values, Open PR materializes a **stack** instead of one PR —
 * this module cuts a per-slice branch from the feature branch's own merge
 * history, pushes each, and opens the chained PRs (PR-1 → the default base, PR-N
 * → slice-(N-1)'s branch) with explicit "Part N of M — based on #prev" metadata
 * in each body, so a human merges the stack bottom-up.
 *
 * The cut is a **replay, not a truncation.** Slices are a *readability* concern,
 * so two Issues in different slices can be dependency-independent and merge into
 * the feature branch interleaved. Truncating the feature branch at "slice N's
 * last merge commit" then leaks a later-but-earlier-merged slice's work into an
 * earlier slice. Instead the materializer reconstructs each slice branch by
 * cherry-picking *only that slice's own Issue work* onto the prior slice branch,
 * in feature-history order — which {@link planStackCut} lays out and the
 * {@link StackGitSeam} executes. (This is the validated git mechanic the Issue
 * left open: "the exact git invocations… are to be validated against real git.")
 *
 * Every git/`gh` edge is injected, so the orchestration is unit-tested with
 * in-memory fakes and no real git/`gh`, mirroring {@link import("./openPr.js")}.
 * It never throws: a slice with no resolvable merges, a failed cut, or a failed
 * `gh` create all come back as a failed {@link StackResult} the caller surfaces.
 */

/** One sliced Issue the materializer needs: its id, `slice:` label, and merged `branch:`. */
export interface SlicedIssue {
  /** The Issue id (filename). */
  readonly id: string;
  /** The Issue's `slice: N-name` value (the materializer gates on ≥2 distinct). */
  readonly slice: string;
  /** The implementor branch recorded on the Issue — the join key to its merge. */
  readonly branch: string | undefined;
}

/** The seams + reads the stack materialization depends on, injected for testing. */
export interface StackDeps {
  /** The git seam that reads merge records and cuts/replays slice branches. */
  readonly git: StackGitSeam;
  /** The `gh`/`git` PR seam — pushes branches and opens the chained PRs. */
  readonly prSeam: PrSeam;
  /** The repo's resolved default base — the bottom PR (slice 1) opens into it. */
  readonly defaultBase: string;
  /** The PRD's sliced Issues (id + `slice:` + `branch:`), source of the slice plan. */
  readonly readSlicedIssues: (prdDir: string) => readonly SlicedIssue[];
}

/**
 * The outcome of materializing a stack: the **bottom** PR's url on success (the
 * stack's entry point, the one a human merges first and the one `go to PR`
 * opens), or a human-readable `error`. Mirrors {@link import("./openPr.js").OpenPrResult}.
 */
export type StackResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/**
 * Whether a PRD's sliced Issues form a stack: ≥2 distinct `slice:` values. The
 * gate the whole stacked-PR feature hangs on — absent or single `slice:` takes
 * exactly today's single-PR path, no new code (CONTEXT.md, ADR 0024). Exported so
 * the Open PR orchestration can branch on it before reaching for this module.
 */
export function isStacked(issues: readonly SlicedIssue[]): boolean {
  const distinct = new Set<string>();
  for (const issue of issues) {
    const slice = issue.slice.trim();
    if (slice) distinct.add(slice);
  }
  return distinct.size >= 2;
}

/**
 * Materialize the stack for one `done` PRD in its single `repo`. Cut a per-slice
 * branch from the feature branch's history (replaying each slice's own work),
 * push each, and open the chained PRs with stack metadata. Returns the bottom
 * PR's url, or a failed result on any git/`gh` failure. Never throws.
 *
 * The caller (the Open PR orchestration) has already resolved the single repo and
 * checked {@link isStacked}; this function owns only the cut + chain.
 */
export function materializeStack(
  prdDir: string,
  repo: string,
  deps: StackDeps,
): StackResult {
  const featureBranch = featureBranchName(basename(prdDir));

  let issues: readonly SlicedIssue[];
  try {
    issues = deps.readSlicedIssues(prdDir);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }

  try {
    const records = deps.git.stackMergeRecords(repo, featureBranch, deps.defaultBase);
    const { merges, sliceOf } = joinIssuesToMerges(issues, records);

    const plan = planStackCut({
      featureBranch,
      base: deps.defaultBase,
      merges,
      sliceOf,
    });
    if (plan.length < 2) {
      // The slices didn't resolve to ≥2 buildable branches (e.g. a slice's merges
      // couldn't be found in history). Refuse rather than open a broken stack.
      return {
        ok: false,
        error: "could not resolve ≥2 slice branches from the feature history",
      };
    }

    // Cut + replay + push each slice branch, bottom-up, before opening any PR — a
    // PR's base branch must exist on the remote first.
    for (const slice of plan) {
      deps.git.createBranchAt(repo, slice.branch, slice.base);
      if (slice.pick.length > 0) deps.git.cherryPick(repo, slice.branch, slice.pick);
      deps.prSeam.push(repo, slice.branch);
    }

    return { ok: true, url: openChainedPrs(repo, plan, deps.prSeam) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Join the PRD's sliced Issues to the feature branch's merge records by the
 * recorded `branch:` field, producing the pure planner's inputs: the merges in
 * feature-history order (each tagged with the Issue it belongs to) and the
 * Issue → `slice:` map. A merge whose branch matches no sliced Issue is dropped
 * (it is not in the stack); an Issue with no recorded branch can't be joined and
 * simply contributes no commits.
 */
function joinIssuesToMerges(
  issues: readonly SlicedIssue[],
  records: readonly MergeRecord[],
): { merges: IssueMerge[]; sliceOf: Record<string, string> } {
  const issueByBranch = new Map<string, SlicedIssue>();
  for (const issue of issues) {
    if (issue.branch) issueByBranch.set(issue.branch, issue);
  }

  const sliceOf: Record<string, string> = {};
  for (const issue of issues) sliceOf[issue.id] = issue.slice;

  const merges: IssueMerge[] = [];
  for (const record of records) {
    const issue = issueByBranch.get(record.branch);
    if (issue === undefined) continue; // a merge for a non-sliced / unknown branch
    merges.push({ issueId: issue.id, workCommits: record.workCommits });
  }
  return { merges, sliceOf };
}

/**
 * Open the chain of PRs over the already-pushed slice branches, bottom-up, and
 * return the **bottom** PR's url (the stack's entry point). Each PR after the
 * first links to the one below it and carries "Part N of M — based on #prev,
 * merge after it" so a human merges in order; the bottom PR says it is the base
 * of the stack.
 */
function openChainedPrs(
  repo: string,
  plan: readonly SliceBranchPlan[],
  prSeam: PrSeam,
): string {
  const total = plan.length;
  const urls: string[] = [];
  plan.forEach((slice, index) => {
    const priorUrl = index === 0 ? undefined : urls[index - 1];
    const url = prSeam.createWithBody(
      repo,
      slice.branch,
      slice.base,
      stackTitle(slice, total),
      stackBody(slice, total, priorUrl),
    );
    urls.push(url);
  });
  return urls[0]!;
}

/**
 * The production `readSlicedIssues`: each Issue's id, `slice:` value, and merged
 * `branch:`, read via the dispatch reader — the same frontmatter the rest of
 * dispatch reads. Issues with no `slice:` are dropped (they are not part of any
 * stack); the stack gate ({@link isStacked}) then sees only sliced Issues, so an
 * un-sliced PRD reports zero and falls through to the single-PR path.
 */
export function realReadSlicedIssues(prdDir: string): readonly SlicedIssue[] {
  const sliced: SlicedIssue[] = [];
  for (const issue of readDispatchView(prdDir).issues) {
    if (issue.slice === undefined) continue;
    sliced.push({ id: issue.id, slice: issue.slice, branch: issue.branch });
  }
  return sliced;
}

/** The stacked PR's title: its slice name + position, e.g. `2-api (part 2 of 3)`. */
function stackTitle(slice: SliceBranchPlan, total: number): string {
  return `${slice.name} (part ${slice.sliceNumber} of ${total})`;
}

/**
 * The stacked PR's body metadata (CONTEXT.md → Stacked output): "Part N of M",
 * the merge-after-the-prior instruction, and a link to the prior PR — so a human
 * lands the stack bottom-up and never merges out of order. The bottom PR (no
 * prior) is marked the base of the stack.
 */
function stackBody(
  slice: SliceBranchPlan,
  total: number,
  priorUrl: string | undefined,
): string {
  const header = `Part ${slice.sliceNumber} of ${total}`;
  if (priorUrl === undefined) {
    return `${header} — base of the stack, merge this first.`;
  }
  return `${header} — based on ${priorUrl}, merge after it.\n\nPrior PR: ${priorUrl}`;
}
