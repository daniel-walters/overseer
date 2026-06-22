import { describe, it, expect } from "vitest";
import { planSlices } from "./slicePlanner.js";
import type { SlicePlanInput } from "./slicePlanner.js";

/**
 * Build a {@link SlicePlanInput} from a terse spec. The planner is pure
 * data-in/data-out (mirroring {@link import("./frontier.js").computeFrontier}),
 * so its "fixtures" are records, not files. `groups` is the LLM author's
 * candidate split — an ordered list of named groups, each naming the Issue ids it
 * proposes to put in one slice — and `tooBig` is the author's too-big gate
 * verdict. `blockedBy` carries the dependency graph keyed by Issue id.
 */
function input(spec: {
  tooBig: boolean;
  groups: readonly {
    name: string;
    issues: readonly string[];
    mergeable?: boolean;
  }[];
  blockedBy?: Readonly<Record<string, readonly string[]>>;
}): SlicePlanInput {
  return {
    tooBig: spec.tooBig,
    groups: spec.groups,
    blockedBy: spec.blockedBy ?? {},
  };
}

describe("planSlices — single-PR fallback gate", () => {
  it("emits no slice fields when the work is not too big", () => {
    // clean-split-but-not-too-big: the too-big gate fails, so one PR.
    const plan = planSlices(
      input({
        tooBig: false,
        groups: [
          { name: "schema", issues: ["001-schema.md"] },
          { name: "api", issues: ["002-api.md"] },
        ],
        blockedBy: { "002-api.md": ["001-schema.md"] },
      }),
    );

    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });
});

describe("planSlices — both gates independently", () => {
  it("falls back to one PR when too big but no clean split exists (forward dep)", () => {
    // too-big-but-no-clean-split: the only candidate split has a forward edge,
    // so there is no valid numbering — one PR.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "schema", issues: ["001-schema.md"] },
          { name: "api", issues: ["002-api.md"] },
        ],
        blockedBy: { "001-schema.md": ["002-api.md"] },
      }),
    );

    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });

  it("falls back to one PR when too big but the author found only one concern", () => {
    // A single group is no split at all (a 1-slice stack is degenerate — below
    // the ≥2-distinct-slices materialization gate), so it stays one PR.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [{ name: "everything", issues: ["001.md", "002.md", "003.md"] }],
      }),
    );

    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });

  it("falls back to one PR when the author proposes no groups at all", () => {
    const plan = planSlices(input({ tooBig: true, groups: [] }));
    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });
});

describe("planSlices — slicing a too-big, cleanly-splittable PRD", () => {
  it("emits slice: N-name numbered in chain order", () => {
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "schema", issues: ["001-schema.md"] },
          { name: "api", issues: ["002-api.md"] },
          { name: "ui", issues: ["003-ui.md"] },
        ],
        blockedBy: {
          "002-api.md": ["001-schema.md"],
          "003-ui.md": ["002-api.md"],
        },
      }),
    );

    expect(plan.sliced).toBe(true);
    expect(plan.assignments).toEqual({
      "001-schema.md": "1-schema",
      "002-api.md": "2-api",
      "003-ui.md": "3-ui",
    });
  });
});

describe("planSlices — no-forward-dependency invariant", () => {
  it("rejects a split where slice N is blocked by a later slice, falling back to one PR", () => {
    // 001 sits in slice 1 but is blocked_by 002 which sits in slice 2: a forward
    // edge makes the stack unbuildable, so to-issues must drop all slice fields.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "schema", issues: ["001-schema.md"] },
          { name: "api", issues: ["002-api.md"] },
        ],
        blockedBy: { "001-schema.md": ["002-api.md"] },
      }),
    );

    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });

  it("accepts a backward dependency (slice N blocked by an earlier slice)", () => {
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "schema", issues: ["001-schema.md"] },
          { name: "api", issues: ["002-api.md"] },
        ],
        blockedBy: { "002-api.md": ["001-schema.md"] },
      }),
    );

    expect(plan.sliced).toBe(true);
  });

  it("verifies the invariant after the cap merge, not on the raw author groups", () => {
    // Six groups collapse under the cap; a forward edge between two groups that
    // land in the SAME merged slice becomes a within-slice dependency, which is
    // allowed — so the merged plan is valid even though the raw groups had a
    // forward edge.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"] },
          { name: "b", issues: ["002.md"] },
          { name: "c", issues: ["003.md"] },
          { name: "d", issues: ["004.md"] },
          { name: "e", issues: ["005.md"] },
          { name: "f", issues: ["006.md"] },
        ],
        // 001 (group a) blocked by 002 (group b): a forward edge in raw order,
        // but a and b merge into slice 1, so it is within-slice once merged.
        blockedBy: { "001.md": ["002.md"] },
      }),
    );

    expect(plan.sliced).toBe(true);
    expect(plan.assignments["001.md"]).toBe(plan.assignments["002.md"]);
  });

  it("accepts a within-slice dependency (slice N blocked by its own slice)", () => {
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "schema", issues: ["001-a.md", "002-b.md"] },
          { name: "api", issues: ["003-api.md"] },
        ],
        blockedBy: { "002-b.md": ["001-a.md"] },
      }),
    );

    expect(plan.sliced).toBe(true);
  });
});

describe("planSlices — soft cap of ~3–4 slices", () => {
  it("keeps a split at or under the cap unmerged", () => {
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"] },
          { name: "b", issues: ["002.md"] },
          { name: "c", issues: ["003.md"] },
          { name: "d", issues: ["004.md"] },
        ],
      }),
    );

    expect(plan.sliced).toBe(true);
    expect(new Set(Object.values(plan.assignments)).size).toBe(4);
  });

  it("merges adjacent slices to bring a 6-slice split under the cap", () => {
    // Six nameable groups exceed the soft cap of 4; to-issues prefers fewer,
    // fatter slices, merging adjacent ones until it fits.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"] },
          { name: "b", issues: ["002.md"] },
          { name: "c", issues: ["003.md"] },
          { name: "d", issues: ["004.md"] },
          { name: "e", issues: ["005.md"] },
          { name: "f", issues: ["006.md"] },
        ],
      }),
    );

    expect(plan.sliced).toBe(true);
    const sliceCount = new Set(Object.values(plan.assignments)).size;
    // Fits the cap but stays a real stack — never over-collapsed below 2, which
    // would defeat the purpose (≥2 distinct slices is the materialization gate).
    expect(sliceCount).toBeGreaterThanOrEqual(2);
    expect(sliceCount).toBeLessThanOrEqual(4);
    // Prefers fewer, fatter slices: 6 groups into ≤4 buckets fills the cap.
    expect(sliceCount).toBe(4);
    // every Issue still carries a slice, numbered 1..sliceCount in chain order.
    expect(Object.keys(plan.assignments).length).toBe(6);
    const numbers = Object.values(plan.assignments).map((v) =>
      Number(v.split("-")[0]),
    );
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(sliceCount);
  });

  it("keeps the merge adjacency-preserving so the chain order survives", () => {
    // Merging only adjacent groups means Issue 001 can never share a slice with
    // a later Issue while an intermediate Issue sits in a different slice — the
    // chain stays a contiguous run.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"] },
          { name: "b", issues: ["002.md"] },
          { name: "c", issues: ["003.md"] },
          { name: "d", issues: ["004.md"] },
          { name: "e", issues: ["005.md"] },
        ],
      }),
    );

    // Slice numbers, read in original group order, must be non-decreasing.
    const order = ["001.md", "002.md", "003.md", "004.md", "005.md"];
    const numbers = order.map((id) => Number(plan.assignments[id]!.split("-")[0]));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]!).toBeGreaterThanOrEqual(numbers[i - 1]!);
    }
  });

  it("falls back to one PR when it cannot fit under the cap with nameable slices", () => {
    // Six concerns, every one marked un-mergeable (merging it with a neighbour
    // would produce a slice that is no longer a one-line nameable concern). No
    // adjacent merge is allowed, so the cap cannot be met → single PR.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"], mergeable: false },
          { name: "b", issues: ["002.md"], mergeable: false },
          { name: "c", issues: ["003.md"], mergeable: false },
          { name: "d", issues: ["004.md"], mergeable: false },
          { name: "e", issues: ["005.md"], mergeable: false },
          { name: "f", issues: ["006.md"], mergeable: false },
        ],
      }),
    );

    expect(plan.sliced).toBe(false);
    expect(plan.assignments).toEqual({});
  });

  it("merges around a forced boundary, keeping un-mergeable groups standalone", () => {
    // Five groups, cap 4. 'c' refuses to merge, so it must stand alone; the
    // remaining optional groups merge so the whole split fits in 4 slices, and
    // 'c' is never folded into a neighbour.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "a", issues: ["001.md"] },
          { name: "b", issues: ["002.md"] },
          { name: "c", issues: ["003.md"], mergeable: false },
          { name: "d", issues: ["004.md"] },
          { name: "e", issues: ["005.md"] },
        ],
      }),
    );

    expect(plan.sliced).toBe(true);
    expect(new Set(Object.values(plan.assignments)).size).toBeLessThanOrEqual(4);
    // 'c' (003) sits in a slice whose name is exactly "c" — never merged.
    const cSlice = plan.assignments["003.md"]!;
    expect(cSlice.replace(/^\d+-/, "")).toBe("c");
  });

  it("subdivides a long flexible run around a fixed slice to fill, not exceed, the cap", () => {
    // One un-mergeable 'gate' plus a 6-group mergeable run. The fixed slice takes
    // one bucket, leaving 3 for the run, which subdivides into 3 — total 4, ≤cap,
    // and the gate stays standalone.
    const plan = planSlices(
      input({
        tooBig: true,
        groups: [
          { name: "gate", issues: ["001.md"], mergeable: false },
          { name: "a", issues: ["002.md"] },
          { name: "b", issues: ["003.md"] },
          { name: "c", issues: ["004.md"] },
          { name: "d", issues: ["005.md"] },
          { name: "e", issues: ["006.md"] },
          { name: "f", issues: ["007.md"] },
        ],
      }),
    );

    expect(plan.sliced).toBe(true);
    const slices = new Set(Object.values(plan.assignments));
    expect(slices.size).toBeLessThanOrEqual(4);
    expect(slices.size).toBeGreaterThanOrEqual(2);
    // The gate is slice 1, standalone, name exactly "gate".
    expect(plan.assignments["001.md"]).toBe("1-gate");
    // Chain order is non-decreasing across the original group order.
    const order = ["001.md", "002.md", "003.md", "004.md", "005.md", "006.md", "007.md"];
    const numbers = order.map((id) => Number(plan.assignments[id]!.split("-")[0]));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]!).toBeGreaterThanOrEqual(numbers[i - 1]!);
    }
  });
});
