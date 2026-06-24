/**
 * A candidate split the `/overseer-to-issues` author proposes: an ordered list
 * of named groups, each naming the Issue ids it would put in one slice. The
 * order is the author's intended chain order (bottom-of-stack first).
 */
export interface SliceGroup {
  /** The one-line nameable concern that makes the slice's PR readable. */
  readonly name: string;
  /** The Issue ids (filenames) the author proposes to put in this slice. */
  readonly issues: readonly string[];
  /**
   * Whether this group may be merged with an adjacent group while the result
   * stays a one-line nameable concern. A group that refuses (`false`) must stand
   * entirely alone — neither folded into a neighbour nor absorbing one — forcing
   * a slice boundary on both sides. Defaults to `true` — most groups merge
   * cleanly. When too many groups refuse to merge to fit the soft cap, the
   * planner falls back to a single PR.
   */
  readonly mergeable?: boolean;
}

/**
 * Everything the pure slice planner needs to decide whether to slice. The two
 * subjective gate inputs — whether the diff is too big, and how the author would
 * name/group the slices — are the author's judgment, made where the whole Issue
 * set is in view; the planner owns only the mechanical, verifiable part.
 */
export interface SlicePlanInput {
  /**
   * The author's too-big gate verdict (rough size estimate + cognitive-load
   * sniff test). One of the two gates that must both pass to slice.
   */
  readonly tooBig: boolean;
  /** The author's candidate split, in intended chain order. */
  readonly groups: readonly SliceGroup[];
  /** The `blocked_by` dependency graph, keyed by Issue id. */
  readonly blockedBy: Readonly<Record<string, readonly string[]>>;
}

/**
 * The planner's verdict. When `sliced` is false the work stays one PR and
 * `assignments` is empty — literally today's single-PR behaviour, the absence of
 * any `slice:` field. When true, `assignments` maps every Issue id to its
 * `slice: N-name` value.
 */
export interface SlicePlan {
  readonly sliced: boolean;
  readonly assignments: Readonly<Record<string, string>>;
}

const SINGLE_PR: SlicePlan = { sliced: false, assignments: {} };

/**
 * The soft cap on stack depth. A deeper stack is its own kind of unreviewable,
 * and a chain of `gh` PRs has a forced merge order — so to-issues prefers fewer,
 * fatter, nameable slices, merging adjacent ones to fit under this.
 */
const SLICE_CAP = 4;

/**
 * Decide whether a PRD's Issues should be split into a stack, and if so assign
 * each Issue its `slice: N-name` value. Pure data-in/data-out — no I/O — so the
 * authoring decision can be tested directly (mirrors {@link
 * import("./frontier.js").computeFrontier}).
 *
 * Both gates must pass or the work stays one PR: it must be too big AND have a
 * clean split. "Clean split" is verified mechanically here — the
 * no-forward-dependency invariant and the soft cap — over the author's candidate
 * groups. Any failure falls back to a single PR (no `slice:` fields).
 */
export function planSlices(plan: SlicePlanInput): SlicePlan {
  if (!plan.tooBig) return SINGLE_PR;

  // A real stack needs ≥2 slices (the materialization gate, ADR 0024/0025). One
  // group — or none — is no split at all, so it stays one PR.
  if (plan.groups.length < 2) return SINGLE_PR;

  const slices = capToSoftLimit(plan.groups);
  // No adjacent merge could bring the split under the cap while keeping every
  // slice nameable → fall back to one PR.
  if (slices === undefined) return SINGLE_PR;
  // A merge that collapsed the split below 2 slices is no stack at all.
  if (slices.length < 2) return SINGLE_PR;

  // Which slice (1-based) each Issue lands in, after the cap merge.
  const sliceOf = new Map<string, number>();
  slices.forEach((group, index) => {
    for (const issue of group.issues) sliceOf.set(issue, index + 1);
  });

  if (!satisfiesNoForwardDependency(sliceOf, plan.blockedBy)) return SINGLE_PR;

  const assignments: Record<string, string> = {};
  slices.forEach((group, index) => {
    const sliceNumber = index + 1;
    for (const issue of group.issues) {
      assignments[issue] = `${sliceNumber}-${group.name}`;
    }
  });

  return { sliced: true, assignments };
}

/**
 * Collapse the author's candidate groups down to at most {@link SLICE_CAP}
 * slices by merging *adjacent* groups, preferring fewer, fatter slices. The
 * merge is adjacency-only so the chain order is preserved — a merged slice is a
 * contiguous run of the original groups, and its name joins theirs with `-`.
 *
 * A group with `mergeable: false` must stand entirely alone — neither folded
 * into a neighbour nor absorbing one — because merging it would produce a slice
 * that is no longer a one-line nameable concern. Those fixed groups split the
 * chain into segments; the flexible runs between them share whatever cap budget
 * the fixed slices leave. Returns `undefined` when even merging every consenting
 * run cannot fit under the cap — the caller then falls back to a single PR.
 * Groups already at or under the cap pass through untouched.
 */
function capToSoftLimit(
  groups: readonly SliceGroup[],
): readonly SliceGroup[] | undefined {
  if (groups.length <= SLICE_CAP) return groups;

  const segments = segmentByMergeability(groups);
  const fixedCount = segments.filter((s) => s.fixed).length;
  const flexible = segments.filter((s) => !s.fixed);

  // Every flexible run needs at least one slice. If the fixed slices alone
  // already exceed the cap, no merge of the flexible runs can rescue it.
  if (fixedCount + flexible.length > SLICE_CAP) return undefined;

  const buckets = allocateBuckets(flexible, SLICE_CAP - fixedCount);

  const slices = segments.flatMap((segment) =>
    segment.fixed
      ? [segment.groups[0]!]
      : packEvenly(segment.groups, buckets.get(segment)!),
  );
  return slices.length <= SLICE_CAP ? slices : undefined;
}

/**
 * Split `budget` slice buckets across the flexible runs, weighted by how many
 * groups each holds so the fattest resulting slice is as small as possible.
 * Every run is guaranteed at least one bucket; the longest runs are served first
 * so rounding favours the runs that most need the buckets. The caller has
 * already guaranteed `budget ≥ flexible.length`.
 */
function allocateBuckets(
  flexible: readonly Segment[],
  budget: number,
): ReadonlyMap<Segment, number> {
  const buckets = new Map<Segment, number>();
  let budgetLeft = budget;
  let groupsLeft = flexible.reduce((n, s) => n + s.groups.length, 0);

  for (const run of [...flexible].sort(
    (a, b) => b.groups.length - a.groups.length,
  )) {
    const runsAfterThis = flexible.length - buckets.size - 1;
    const fairShare = Math.round((run.groups.length / groupsLeft) * budgetLeft);
    // Take the fair share, but never more groups than the run has, and always
    // leave one bucket for each run still to be served.
    const take = clamp(fairShare, 1, Math.min(run.groups.length, budgetLeft - runsAfterThis));
    buckets.set(run, take);
    budgetLeft -= take;
    groupsLeft -= run.groups.length;
  }
  return buckets;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** A run of adjacent groups, flagged `fixed` when it is a lone un-mergeable group. */
interface Segment {
  readonly groups: readonly SliceGroup[];
  readonly fixed: boolean;
}

/**
 * Split the chain at every `mergeable: false` group: that group becomes a
 * `fixed` single-group segment, and each maximal run of mergeable groups becomes
 * a flexible segment that may later be subdivided.
 */
function segmentByMergeability(groups: readonly SliceGroup[]): readonly Segment[] {
  const segments: Segment[] = [];
  let run: SliceGroup[] = [];
  const flushRun = (): void => {
    if (run.length > 0) segments.push({ groups: run, fixed: false });
    run = [];
  };
  for (const group of groups) {
    if (group.mergeable === false) {
      flushRun();
      segments.push({ groups: [group], fixed: true });
    } else {
      run.push(group);
    }
  }
  flushRun();
  return segments;
}

/**
 * Pack a run of adjacent groups into `buckets` contiguous slices of as-even-as-
 * possible size (larger buckets first), preserving order. Each slice's name
 * joins its groups' names with `-` and its issues concatenate.
 */
function packEvenly(
  groups: readonly SliceGroup[],
  buckets: number,
): readonly SliceGroup[] {
  const base = Math.floor(groups.length / buckets);
  const remainder = groups.length % buckets;
  const slices: SliceGroup[] = [];
  let cursor = 0;
  for (let b = 0; b < buckets; b++) {
    const size = base + (b < remainder ? 1 : 0);
    const span = groups.slice(cursor, cursor + size);
    cursor += size;
    slices.push({
      name: span.map((g) => g.name).join("-"),
      issues: span.flatMap((g) => g.issues),
    });
  }
  return slices;
}

/**
 * Verify the no-forward-dependency invariant: every Issue in slice N may be
 * `blocked_by:` only Issues in slice ≤ N. A forward edge (an Issue blocked by a
 * later slice) makes the cut-from-history stack unbuildable (ADR 0024), so the
 * candidate split is rejected. Blockers not present in any slice are ignored —
 * the planner judges only the cut it was handed.
 */
function satisfiesNoForwardDependency(
  sliceOf: ReadonlyMap<string, number>,
  blockedBy: Readonly<Record<string, readonly string[]>>,
): boolean {
  for (const [issue, slice] of sliceOf) {
    for (const blocker of blockedBy[issue] ?? []) {
      const blockerSlice = sliceOf.get(blocker);
      if (blockerSlice !== undefined && blockerSlice > slice) return false;
    }
  }
  return true;
}
