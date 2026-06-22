import { sliceBranchName } from "./gitSetup.js";

/**
 * The pure stack cut planner: the heart of stacked Open PR (CONTEXT.md → Stacked
 * output, ADR 0024). Given the feature branch's own merge history and each
 * Issue's `slice: N-name` value, it produces an ordered list of per-slice branch
 * plans — which work commits each slice branch picks (so its PR's diff is its
 * slice only) and what base each slice's PR opens into (PR-1 → the default base,
 * PR-N → slice-(N-1)'s branch).
 *
 * It is pure data-in/data-out (no git, no `gh`), so the cut is reasoned about and
 * tested directly against constructed merge histories — including the
 * interleaved/parallel case that defeats a naive "truncate the feature branch at
 * slice N's last merge commit" (that leaks a later-but-earlier-merged slice's
 * work into an earlier slice). The correct, history-faithful cut is to *replay*
 * only each slice's own Issue work, slice by slice, onto the prior slice — which
 * is what this planner expresses and the materializer's seam executes via
 * cherry-pick.
 */

/**
 * One Issue's merge as it lands on the feature branch, in feature-history
 * (oldest-first) order. The impure caller resolves each `--no-ff` merge commit on
 * the feature branch to the Issue that produced it (via the recorded `branch:`)
 * and the work commit(s) that merge contributed — the planner stays pure over
 * these records and never touches git.
 */
export interface IssueMerge {
  /** The Issue id (filename) this merge belongs to. */
  readonly issueId: string;
  /**
   * The work commit(s) this Issue contributed, oldest-first — the order a
   * faithful replay (cherry-pick) onto the prior slice must preserve.
   */
  readonly workCommits: readonly string[];
}

/** Everything the pure cut planner needs to lay out the stack's branches. */
export interface StackCutInput {
  /** The PRD feature branch the slice branches are cut from. */
  readonly featureBranch: string;
  /** The repo's resolved default base — the bottom PR (slice 1) opens into it. */
  readonly base: string;
  /** Every Issue's merge, in feature-history (oldest-first) order. */
  readonly merges: readonly IssueMerge[];
  /** Each Issue id's `slice: N-name` value. */
  readonly sliceOf: Readonly<Record<string, string>>;
}

/**
 * One slice's branch plan: the branch to create, the base its PR opens into
 * (the prior slice's branch, or the default base for slice 1), and the work
 * commits to replay onto that base — in feature-history order, so the slice
 * branch reconstructs exactly its own Issues' work and nothing else.
 */
export interface SliceBranchPlan {
  /** The slice's 1-based position in the chain. */
  readonly sliceNumber: number;
  /** The slice's `N-name` label (its `slice:` value), for the PR title/body. */
  readonly name: string;
  /** The branch this slice is cut as. */
  readonly branch: string;
  /** The base this slice's PR opens into — slice-(N-1)'s branch, or {@link base}. */
  readonly base: string;
  /** The work commits to replay (cherry-pick) onto the base, oldest-first. */
  readonly pick: readonly string[];
}

/**
 * Lay out the stack: group the feature branch's Issue merges by slice, order the
 * slices ascending by their leading number, and within each slice collect its
 * work commits in feature-history order. Each slice's PR base is the previous
 * slice's branch (slice 1's is the default base), so the chain is bottom-up.
 *
 * Pure: the same inputs always yield the same plan, and an interleaved merge
 * history (slice 1's second Issue merging *after* slice 2's first) still produces
 * the right per-slice commit lists — because grouping is by the Issue's slice,
 * never by merge position.
 */
export function planStackCut(input: StackCutInput): readonly SliceBranchPlan[] {
  // slice number → { name, pick[] }, built in slice-number order so the chain is
  // bottom-up. The work commits accumulate in feature-history order because we
  // walk `merges` (already oldest-first) once.
  const bySlice = new Map<number, { name: string; pick: string[] }>();

  for (const m of input.merges) {
    const label = input.sliceOf[m.issueId];
    if (label === undefined) continue; // an Issue with no slice is not in the stack
    const sliceNumber = leadingNumber(label);
    let entry = bySlice.get(sliceNumber);
    if (entry === undefined) {
      entry = { name: label, pick: [] };
      bySlice.set(sliceNumber, entry);
    }
    entry.pick.push(...m.workCommits);
  }

  const ordered = [...bySlice.entries()].sort(([a], [b]) => a - b);

  const plans: SliceBranchPlan[] = [];
  ordered.forEach(([sliceNumber, entry], index) => {
    const branch = sliceBranchName(input.featureBranch, entry.name);
    const base = index === 0 ? input.base : plans[index - 1]!.branch;
    plans.push({ sliceNumber, name: entry.name, branch, base, pick: entry.pick });
  });
  return plans;
}

/** The leading slice number of a `N-name` label (e.g. `2-api` → 2). */
function leadingNumber(label: string): number {
  return Number.parseInt(label, 10);
}
