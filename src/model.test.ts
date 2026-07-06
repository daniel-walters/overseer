import { describe, it, expect } from "vitest";
import {
  placeStatus,
  derivePrdLane,
  derivePrdNeedsReview,
  derivePrdStalled,
  derivePrdTolerated,
  ISSUE_LANES,
  type Lane,
  type Issue,
  type HumanReviewReason,
} from "./model.js";

/** Build a minimal Issue carrying just the lane the derivation reads. */
function issue(lane: Lane): Issue {
  return { id: `${lane}.md`, title: lane, lane };
}

/** Build a `ready-for-agent` Issue, optionally waiting on the given blockers. */
function readyForAgent(id: string, blockedBy: readonly string[] = []): Issue {
  return { id, title: id, lane: "ready", readyFor: "agent", blockedBy };
}

/**
 * Build the Issue a missing/unrecognised status now produces: folded into the
 * backlog lane carrying the `malformedStatus` overlay. The retired `unsorted`
 * lane's PRD-derivation behaviour (pre-in-progress, blocks all-done) must be
 * preserved by this fold.
 */
function malformedIssue(): Issue {
  return { id: "malformed.md", title: "malformed", lane: "backlog", malformedStatus: true };
}

/**
 * `placeStatus` is the single derived status→lane mapping every reader shares.
 * The scanner wraps it with the unsorted fail-safe; these tests pin the raw
 * mapping (and its `undefined` for unknown input) directly.
 */
describe("placeStatus", () => {
  it("maps each plain authored status to its same-named lane with no badge", () => {
    for (const status of [
      "backlog",
      "in-progress",
      "ready-for-review",
      "in-review",
      "human-review",
      "done",
    ] as const) {
      expect(placeStatus(status)).toEqual({ lane: status });
    }
  });

  it("folds both ready-for-* statuses into the single ready lane with a badge", () => {
    expect(placeStatus("ready-for-human")).toEqual({ lane: "ready", readyFor: "human" });
    expect(placeStatus("ready-for-agent")).toEqual({ lane: "ready", readyFor: "agent" });
  });

  it("folds both audit-phase statuses into the single audit lane with no badge", () => {
    // `ready-for-audit` (awaiting) and `in-audit` (active) collapse to one `audit`
    // column; the active/waiting distinction is carried by the liveness overlay,
    // not a second column (ADR 0026).
    expect(placeStatus("ready-for-audit")).toEqual({ lane: "audit" });
    expect(placeStatus("in-audit")).toEqual({ lane: "audit" });
  });

  it("returns undefined for an unrecognised, empty, or non-string status", () => {
    expect(placeStatus("nonsense")).toBeUndefined();
    expect(placeStatus("")).toBeUndefined();
    expect(placeStatus(undefined)).toBeUndefined();
    expect(placeStatus(42)).toBeUndefined();
  });

  it("returns undefined for a status that names an Object.prototype member", () => {
    // A bare property index would read these inherited functions off the
    // placement literal and return them as bogus placements, slipping past the
    // unsorted fail-safe and crashing lane grouping with a `lane: undefined` card.
    for (const key of [
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "__proto__",
    ]) {
      expect(placeStatus(key)).toBeUndefined();
    }
  });

  it("only ever yields lanes that exist in the render order", () => {
    const lanes = new Set<Lane>(ISSUE_LANES);
    for (const status of [
      "backlog",
      "ready-for-human",
      "ready-for-agent",
      "in-progress",
      "ready-for-audit",
      "in-audit",
      "ready-for-review",
      "in-review",
      "human-review",
      "done",
    ]) {
      const placed = placeStatus(status);
      expect(placed).toBeDefined();
      expect(lanes.has(placed!.lane)).toBe(true);
    }
  });
});

/**
 * A PRD carries no stored status (ADR 0003); its board lane is derived from its
 * Issues at read time, collapsing to backlog / in-progress / done.
 */
describe("derivePrdLane", () => {
  it("derives done when there is at least one Issue and every Issue is done", () => {
    expect(derivePrdLane([issue("done"), issue("done")])).toBe("done");
  });

  it("derives in-progress when any Issue is in-progress or later", () => {
    // `audit` covers both ready-for-audit and in-audit (they fold to one lane): a
    // PRD with an Issue in the audit phase reads as work-underway (ADR 0026).
    for (const lane of [
      "in-progress",
      "audit",
      "ready-for-review",
      "in-review",
      "human-review",
    ] as const) {
      expect(derivePrdLane([issue("backlog"), issue(lane)])).toBe("in-progress");
    }
  });

  it("derives backlog when Issues are only backlog/ready, or there are none", () => {
    expect(derivePrdLane([])).toBe("backlog");
    expect(derivePrdLane([issue("backlog"), issue("ready")])).toBe("backlog");
  });

  it("treats a malformed-status Issue as pre-in-progress, never advancing the PRD", () => {
    // A missing/unknown status (now folded into backlog + malformedStatus) does
    // not promote the PRD to in-progress on its own — the retired Unsorted lane's
    // pre-in-progress behaviour is preserved by the fold.
    expect(derivePrdLane([issue("backlog"), malformedIssue()])).toBe("backlog");
  });

  it("treats a malformed-status Issue as not-done, blocking the all-done derivation", () => {
    // ...and a done + malformed PRD is in-progress, not done: an unknown-status
    // Issue can never silently complete a PRD, exactly as Unsorted blocked it.
    expect(derivePrdLane([issue("done"), malformedIssue()])).toBe("in-progress");
  });
});

/** An Issue parked in `human-review` carrying a given escalation reason. */
function humanReviewIssue(reason: HumanReviewReason): Issue {
  return { id: `${reason}.md`, title: reason, lane: "human-review", humanReviewReason: reason };
}

/**
 * The board-level needs-review roll-up: a PRD needs review iff ≥1 of its Issues
 * is parked in `human-review` — the one lane genuinely blocked on a human. A
 * derived overlay computed from the Issues each scan, never written to `prd.md`
 * (ADR 0002 / 0003). Presence-only, scoped to `human-review` only, and
 * reason-agnostic.
 */
describe("derivePrdNeedsReview", () => {
  it("is true when at least one Issue is in human-review", () => {
    expect(
      derivePrdNeedsReview([issue("in-progress"), humanReviewIssue("conflict")]),
    ).toBe(true);
  });

  it("is false when no Issue is in human-review", () => {
    expect(derivePrdNeedsReview([issue("backlog"), issue("in-progress"), issue("done")])).toBe(
      false,
    );
  });

  it("is false for an empty PRD", () => {
    expect(derivePrdNeedsReview([])).toBe(false);
  });

  it("is true regardless of which escalation reason the human-review Issue carries", () => {
    for (const reason of ["deviation", "non-convergence", "conflict"] as const) {
      expect(derivePrdNeedsReview([humanReviewIssue(reason)])).toBe(true);
    }
  });
});

describe("derivePrdStalled", () => {
  it("is true with an unblocked ready-for-agent Issue and nothing in flight", () => {
    expect(derivePrdStalled([readyForAgent("001.md"), issue("done")])).toBe(true);
  });

  it("is false when an Issue is in flight, even with agent work waiting", () => {
    expect(derivePrdStalled([readyForAgent("001.md"), issue("in-progress")])).toBe(false);
    expect(derivePrdStalled([readyForAgent("001.md"), issue("in-review")])).toBe(false);
    // `audit` lane covers both in-audit (active) and ready-for-audit (awaiting):
    // either way work is in-flight or pending handoff, so the PRD is not stalled.
    expect(derivePrdStalled([readyForAgent("001.md"), issue("audit")])).toBe(false);
  });

  it("is false when the ready-for-agent Issue is still blocked", () => {
    expect(
      derivePrdStalled([readyForAgent("002.md", ["001.md"]), issue("backlog")]),
    ).toBe(false);
  });

  it("is true once the blocker is done", () => {
    const blocker: Issue = { id: "001.md", title: "001", lane: "done" };
    expect(derivePrdStalled([readyForAgent("002.md", ["001.md"]), blocker])).toBe(true);
  });

  it("is false for a ready-for-human Issue (not agent work)", () => {
    const readyForHuman: Issue = {
      id: "001.md",
      title: "001",
      lane: "ready",
      readyFor: "human",
    };
    expect(derivePrdStalled([readyForHuman])).toBe(false);
  });

  it("is false for a PRD with no waiting agent work", () => {
    expect(derivePrdStalled([])).toBe(false);
    expect(derivePrdStalled([issue("backlog"), issue("done")])).toBe(false);
  });
});

/** A `done` Issue that merged with tolerated findings (carries the marker). */
function toleratedIssue(id = "tolerated.md"): Issue {
  return { id, title: id, lane: "done", tolerated: true };
}

/**
 * The board-level tolerated roll-up: a PRD reads as carrying tolerated findings
 * iff ≥1 of its Issues carries the `tolerated` marker (a `done` Issue that merged
 * with tolerated findings — ADR 0027). A derived overlay, presence-only, computed
 * from the Issues each scan and never written to `prd.md`.
 */
describe("derivePrdTolerated", () => {
  it("is true when at least one Issue merged with tolerated findings", () => {
    expect(derivePrdTolerated([issue("done"), toleratedIssue()])).toBe(true);
  });

  it("is false when no Issue carries the tolerated marker", () => {
    expect(derivePrdTolerated([issue("done"), issue("in-progress")])).toBe(false);
  });

  it("is false for an empty PRD", () => {
    expect(derivePrdTolerated([])).toBe(false);
  });
});
