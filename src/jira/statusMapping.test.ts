import { describe, it, expect } from "vitest";
import {
  DEFAULT_EPIC_STATUS_NAMES,
  epicTargetStatus,
  statusEquals,
  type EpicStatusNames,
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

describe("statusEquals", () => {
  it("matches names case- and whitespace-insensitively", () => {
    expect(statusEquals("In Progress", "in progress")).toBe(true);
    expect(statusEquals("  Done ", "done")).toBe(true);
  });

  it("distinguishes genuinely different status names", () => {
    expect(statusEquals("To Do", "Done")).toBe(false);
  });
});
