import { describe, it, expect } from "vitest";
import {
  DEFAULT_EPIC_STATUS_NAMES,
  DEFAULT_ISSUE_STATUS_NAMES,
  epicTargetStatus,
  issueTargetStatus,
  statusEquals,
  type EpicStatusNames,
  type IssueStatusNames,
} from "./statusMapping.js";

describe("epicTargetStatus", () => {
  it("maps each PRD lane to its default named epic status", () => {
    expect(epicTargetStatus("backlog")).toBe("To Do");
    expect(epicTargetStatus("in-progress")).toBe("In Progress");
    expect(epicTargetStatus("done")).toBe("Done");
  });

  it("honours a per-board status-name override", () => {
    const names: EpicStatusNames = {
      backlog: "Backlog",
      inProgress: "Building",
      done: "Shipped",
    };
    expect(epicTargetStatus("backlog", names)).toBe("Backlog");
    expect(epicTargetStatus("in-progress", names)).toBe("Building");
    expect(epicTargetStatus("done", names)).toBe("Shipped");
  });

  it("exposes the conventional JIRA names as the default map", () => {
    expect(DEFAULT_EPIC_STATUS_NAMES).toEqual({
      backlog: "To Do",
      inProgress: "In Progress",
      done: "Done",
    });
  });
});

describe("issueTargetStatus", () => {
  // The full authored-status vocabulary the mirror coarsens to four buckets
  // (CONTEXT.md → JIRA mirror). Exhaustive over all ten authored statuses so a
  // renamed/added status can't silently fall through to a wrong bucket.
  it.each([
    // To Do bucket: not-yet-started.
    ["backlog", "To Do"],
    ["ready-for-human", "To Do"],
    ["ready-for-agent", "To Do"],
    // In Progress bucket: being built.
    ["in-progress", "In Progress"],
    // In Review bucket: everything under review, incl. the human bottleneck
    // (human-review folds in, deliberately low-noise — user story 16).
    ["ready-for-audit", "In Review"],
    ["in-audit", "In Review"],
    ["ready-for-review", "In Review"],
    ["in-review", "In Review"],
    ["human-review", "In Review"],
    // Done bucket.
    ["done", "Done"],
  ])("maps authored status %s to the default named status %s", (status, expected) => {
    expect(issueTargetStatus(status)).toBe(expected);
  });

  it("honours a per-board status-name override across all four buckets", () => {
    const names: IssueStatusNames = {
      backlog: "Backlog",
      inProgress: "Building",
      inReview: "Reviewing",
      done: "Shipped",
    };
    expect(issueTargetStatus("ready-for-agent", names)).toBe("Backlog");
    expect(issueTargetStatus("in-progress", names)).toBe("Building");
    expect(issueTargetStatus("human-review", names)).toBe("Reviewing");
    expect(issueTargetStatus("done", names)).toBe("Shipped");
  });

  it("returns undefined for a status outside the authored vocabulary", () => {
    // A data-error status the board would fold into backlog/malformed: the mirror
    // has no bucket for it, so the reconciler skips the child's self-heal rather
    // than driving it to a wrong column.
    expect(issueTargetStatus("nonsense")).toBeUndefined();
    expect(issueTargetStatus("")).toBeUndefined();
    // Own-property guard: an Object.prototype member name is not a status.
    expect(issueTargetStatus("toString")).toBeUndefined();
  });

  it("exposes the conventional JIRA names as the default four-bucket map", () => {
    expect(DEFAULT_ISSUE_STATUS_NAMES).toEqual({
      backlog: "To Do",
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
    });
  });
});

describe("statusEquals", () => {
  it("matches names case- and whitespace-insensitively", () => {
    expect(statusEquals("In Progress", "in progress")).toBe(true);
    expect(statusEquals("  Done ", "done")).toBe(true);
  });

  it("distinguishes genuinely different status names", () => {
    expect(statusEquals("To Do", "Done")).toBe(false);
  });
});
