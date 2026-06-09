import { describe, it, expect } from "vitest";
import { placeStatus, LANES, type Lane } from "./model.js";

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
    const lanes = new Set<Lane>(LANES);
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
