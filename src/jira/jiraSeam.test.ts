import { describe, it, expect } from "vitest";
import {
  parseBoardProject,
  parseSearchStatuses,
  parseCreatedKey,
  parseActiveSprintId,
} from "./jiraSeam.js";

describe("parseBoardProject", () => {
  it("reads the first project's key from `board list-projects --json`", () => {
    // The real acli shape (acli 1.3.x): a `projects` array of project objects.
    const json = JSON.stringify({
      isLast: true,
      projects: [{ id: "10500", key: "DS", name: "Data Sourcery" }],
      total: 1,
    });
    expect(parseBoardProject(json)).toBe("DS");
  });

  it("returns undefined for an empty project list", () => {
    expect(parseBoardProject(JSON.stringify({ projects: [] }))).toBeUndefined();
  });

  it("returns undefined for unparseable or shapeless output", () => {
    expect(parseBoardProject("not json")).toBeUndefined();
    expect(parseBoardProject(JSON.stringify({ total: 0 }))).toBeUndefined();
  });
});

describe("parseSearchStatuses", () => {
  it("reads each work item's key + status name from `workitem search --json`", () => {
    // The real acli shape: an array of items, each with a key and a
    // fields.status.name — the batched seed of the reconcile cache.
    const json = JSON.stringify([
      { key: "DS-9", fields: { status: { id: "3", name: "In Progress" } } },
      { key: "DS-50", fields: { status: { id: "1", name: "To Do" } } },
    ]);
    expect(parseSearchStatuses(json)).toEqual([
      { key: "DS-9", status: "In Progress" },
      { key: "DS-50", status: "To Do" },
    ]);
  });

  it("keeps a keyed item whose status is unreadable, with an undefined status", () => {
    // A row with no parseable status still names a real, present key — the cache
    // records that the item exists (status unknown) rather than dropping it.
    const json = JSON.stringify([{ key: "DS-9", fields: {} }]);
    expect(parseSearchStatuses(json)).toEqual([
      { key: "DS-9", status: undefined },
    ]);
  });

  it("skips keyless rows and returns [] for unparseable or shapeless output", () => {
    expect(parseSearchStatuses(JSON.stringify([{ fields: {} }]))).toEqual([]);
    expect(parseSearchStatuses("not json")).toEqual([]);
    expect(parseSearchStatuses(JSON.stringify({ total: 0 }))).toEqual([]);
  });
});

describe("parseCreatedKey", () => {
  it("reads the created key from a JSON object with a key", () => {
    expect(parseCreatedKey(JSON.stringify({ key: "DS-100" }))).toBe("DS-100");
  });

  it("reads the created key from a single-element array", () => {
    expect(parseCreatedKey(JSON.stringify([{ key: "DS-100" }]))).toBe("DS-100");
  });

  it("falls back to scanning a human-readable line for the key", () => {
    // Belt-and-braces: even if acli prints a plain success line, recover the key.
    expect(parseCreatedKey("Work item DS-100 has been created")).toBe("DS-100");
  });

  it("returns undefined when no key can be found", () => {
    expect(parseCreatedKey("")).toBeUndefined();
    expect(parseCreatedKey(JSON.stringify({ id: "123" }))).toBeUndefined();
  });

  it("never scans a parsed-but-shapeless JSON payload for a stray key-shaped substring", () => {
    // An error payload that happens to mention an unrelated ticket must not be
    // mistaken for the created epic's key — it parses as JSON, so its shape is
    // trusted (no `key` field ⇒ undefined), never the raw-text regex fallback.
    const errorJson = JSON.stringify({
      errorMessages: ["Related to DS-42, cannot create: permission denied"],
    });
    expect(parseCreatedKey(errorJson)).toBeUndefined();
  });
});

describe("parseActiveSprintId", () => {
  it("reads the first sprint's id from `board list-sprints --state active --json`", () => {
    // The real acli shape mirrors the Agile API: a `sprints` array of sprint
    // objects, each with a numeric `id`. Called with `--state active`, every
    // returned sprint is active, so the first one is the board's active sprint.
    const json = JSON.stringify({
      isLast: true,
      sprints: [
        { id: 87, state: "active", name: "Sprint 12" },
        { id: 88, state: "active", name: "Sprint 13" },
      ],
    });
    // Numeric ids coerce to their string form (the seam speaks in string ids).
    expect(parseActiveSprintId(json)).toBe("87");
  });

  it("returns undefined when the board has no active sprint (empty list)", () => {
    // Degrades to a logged no-op upstream: no active sprint ⇒ leave in backlog.
    expect(parseActiveSprintId(JSON.stringify({ sprints: [] }))).toBeUndefined();
  });

  it("returns undefined for unparseable or shapeless output", () => {
    expect(parseActiveSprintId("not json")).toBeUndefined();
    expect(parseActiveSprintId(JSON.stringify({ isLast: true }))).toBeUndefined();
  });
});
