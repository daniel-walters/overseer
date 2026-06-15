import { describe, it, expect } from "vitest";
import { placeStatus, derivePrdLane, ISSUE_LANES, type Lane, type Issue } from "./model.js";

/** Build a minimal Issue carrying just the lane the derivation reads. */
function issue(lane: Lane): Issue {
  return { id: `${lane}.md`, title: lane, lane };
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
    for (const lane of [
      "in-progress",
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
