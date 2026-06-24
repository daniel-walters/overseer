import { describe, it, expect } from "vitest";
import { planStackCut, type IssueMerge } from "./stackCutPlanner.js";

/**
 * The stack cut planner is the pure heart of stacked Open PR (CONTEXT.md → Open
 * PR / Stacked output, ADR 0024): given the feature branch's own merge history
 * (each Issue's merge, in feature-history order) and the `slice: N-name` value
 * each Issue carries, it maps them to an ordered list of per-slice branch plans —
 * which commits each slice branch picks, and what each slice's PR base is.
 *
 * It is pure data-in/data-out (no git, no `gh`), so the interleaved/parallel
 * merge cases the materializer must survive are tested directly against
 * constructed merge histories — exactly as `slicePlanner.test.ts` tests the
 * authoring decision and `frontier.test.ts` tests the dispatch frontier.
 *
 * A merge record names the Issue it belongs to (resolved upstream from the merge
 * commit's recorded `branch:`), the work commit(s) it contributes, in
 * feature-history (oldest-first) order — the order a faithful replay must keep.
 */
function merge(issueId: string, ...workCommits: string[]): IssueMerge {
  return { issueId, workCommits };
}

const FEATURE = "stacked-prs";
const BASE = "main";

describe("planStackCut — in-order merge history", () => {
  it("cuts one branch per slice, picking that slice's work in history order", () => {
    // slice 1 = {A,B}, slice 2 = {C}, slice 3 = {D}; merged in slice order.
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("B", "wB"), merge("C", "wC"), merge("D", "wD")],
      sliceOf: { A: "1-schema", B: "1-schema", C: "2-api", D: "3-ui" },
    });

    expect(plan.map((s) => s.name)).toEqual(["1-schema", "2-api", "3-ui"]);
    expect(plan.map((s) => s.pick)).toEqual([["wA", "wB"], ["wC"], ["wD"]]);
  });

  it("chains the bases bottom-up: PR-1 → default base, PR-N → slice-(N-1)'s branch", () => {
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("C", "wC"), merge("D", "wD")],
      sliceOf: { A: "1-schema", C: "2-api", D: "3-ui" },
    });

    expect(plan[0]!.base).toBe(BASE); // slice 1 opens into the default base
    expect(plan[1]!.base).toBe(plan[0]!.branch); // slice 2 opens into slice 1's branch
    expect(plan[2]!.base).toBe(plan[1]!.branch); // slice 3 opens into slice 2's branch
    // The branches are derived from the feature branch + slice label, never stored.
    expect(plan[0]!.branch).toBe(`${FEATURE}-slice-1-schema`);
    expect(plan[1]!.branch).toBe(`${FEATURE}-slice-2-api`);
  });
});

describe("planStackCut — interleaved / parallel merge history", () => {
  it("groups by slice, not by merge position: slice 1's late merge stays in slice 1", () => {
    // Merge order is A(s1), C(s2), B(s1), D(s3) — slice 1's second Issue (B)
    // merges *after* slice 2's only Issue (C). A naive truncate-at-last-merge
    // would leak C into slice 1; grouping by slice keeps each slice clean.
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("C", "wC"), merge("B", "wB"), merge("D", "wD")],
      sliceOf: { A: "1-schema", B: "1-schema", C: "2-api", D: "3-ui" },
    });

    expect(plan.map((s) => s.name)).toEqual(["1-schema", "2-api", "3-ui"]);
    // Slice 1 picks A then B (feature-history order), never C — even though C
    // merged between them. Slice 2 picks only C, slice 3 only D.
    expect(plan.map((s) => s.pick)).toEqual([["wA", "wB"], ["wC"], ["wD"]]);
  });

  it("keeps multiple work commits per Issue in feature-history order", () => {
    // An Issue can land more than one commit through its merge's second-parent
    // history; the replay must preserve their order.
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA1", "wA2"), merge("B", "wB"), merge("C", "wC1", "wC2")],
      sliceOf: { A: "1-schema", B: "1-schema", C: "2-api" },
    });

    expect(plan.map((s) => s.pick)).toEqual([["wA1", "wA2", "wB"], ["wC1", "wC2"]]);
  });
});

describe("planStackCut — malformed slice labels", () => {
  it("skips issues whose slice label has no leading digit (no NaN key collision)", () => {
    // Labels like 'frontend' and 'backend' (no leading digit) must not collapse
    // into one Map entry via parseInt('frontend') === NaN === parseInt('backend').
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("B", "wB")],
      sliceOf: { A: "frontend", B: "backend" },
    });

    // Both labels are malformed (no leading digit) so they are skipped entirely.
    expect(plan).toEqual([]);
  });

  it("accepts digit-prefixed labels and skips non-digit ones in the same input", () => {
    // 'frontend' is skipped; '1-schema' and '2-api' produce two valid slices.
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("B", "wB"), merge("C", "wC")],
      sliceOf: { A: "frontend", B: "1-schema", C: "2-api" },
    });

    expect(plan).toHaveLength(2);
    expect(plan.map((s) => s.name)).toEqual(["1-schema", "2-api"]);
    expect(plan.map((s) => s.pick)).toEqual([["wB"], ["wC"]]);
  });
});

describe("planStackCut — degenerate slice counts (M = 1 / none)", () => {
  it("a single distinct slice yields one plan (the materializer falls back to one PR)", () => {
    // Whether to stack at all is the materializer's ≥2-distinct-slices gate; the
    // planner just reports the slices it was handed. One slice → one plan, which
    // the materializer reads as "not a stack" and opens today's single PR.
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("B", "wB")],
      sliceOf: { A: "1-only", B: "1-only" },
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]!.base).toBe(BASE);
  });

  it("no sliced Issues yields an empty plan", () => {
    const plan = planStackCut({
      featureBranch: FEATURE,
      base: BASE,
      merges: [merge("A", "wA"), merge("B", "wB")],
      sliceOf: {},
    });

    expect(plan).toEqual([]);
  });
});
