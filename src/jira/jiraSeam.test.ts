import { describe, it, expect } from "vitest";
import {
  resolveProjectKey,
  parseSearchStatuses,
  parseCreatedKey,
  parseActiveSprintId,
} from "./jiraSeam.js";

describe("resolveProjectKey", () => {
  it("resolves a single-project board to its one project", () => {
    // The common, zero-config case: a board that lists exactly one project
    // resolves to it regardless of location (user story 7).
    const listProjects = JSON.stringify({
      isLast: true,
      projects: [{ id: "10500", key: "DS", name: "Data Sourcery" }],
      total: 1,
    });
    const boardGet = JSON.stringify({ id: 34, location: "Data Sourcery (DS)" });
    expect(resolveProjectKey({ boardGet, listProjects })).toEqual({
      kind: "resolved",
      key: "DS",
    });
  });

  it("lets an explicit override win over the board's own projects", () => {
    // The author's `project` override always wins — even against a board that
    // would otherwise resolve to something else (user story 8): the override is
    // the deliberate fallback when the home project can't be derived.
    const listProjects = JSON.stringify({
      projects: [
        { key: "CABB", name: "Culture Amp Bug Board" },
        { key: "ESD", name: "Team Survey Design" },
      ],
    });
    const boardGet = JSON.stringify({ location: "Team Survey Design (ESD)" });
    expect(
      resolveProjectKey({ boardGet, listProjects, override: "OVR" }),
    ).toEqual({ kind: "resolved", key: "OVR" });
  });

  it("resolves a multi-project board to the location's project, not the first listed (board 681 regression)", () => {
    // The real board 681 payloads: a multi-project filter board that lists the
    // `CABB` bug project *before* `ESD`, with a location naming Survey Design (ESD).
    // The old `list-projects[0]` shortcut picked `CABB` and the mirror silently
    // mis-targeted; resolution must cross-reference the location and land on `ESD`.
    const listProjects = JSON.stringify({
      isLast: true,
      maxResults: 50,
      projects: [
        { id: "11380", key: "CABB", name: "Culture Amp Bug Board" },
        { id: "11285", key: "ESD", name: "Team Survey Design" },
      ],
      startAt: 0,
      total: 2,
    });
    const boardGet = JSON.stringify({
      id: 681,
      location: "Team Survey Design (ESD)",
      name: "🚀 Survey Design Delivery 2026",
      type: "scrum",
    });
    expect(resolveProjectKey({ boardGet, listProjects })).toEqual({
      kind: "resolved",
      key: "ESD",
    });
  });

  it("returns ambiguous when a multi-project board's location matches no listed project and there is no override", () => {
    // A genuinely unresolvable board: several projects, a location that names none
    // of them, no override. The reconciler treats this as a logged no-op (never a
    // wrong-project create), so the author must supply a `project` override.
    const listProjects = JSON.stringify({
      projects: [
        { key: "CABB", name: "Culture Amp Bug Board" },
        { key: "ESD", name: "Team Survey Design" },
      ],
    });
    const boardGet = JSON.stringify({ location: "Some Other Team (XYZ)" });
    const resolution = resolveProjectKey({ boardGet, listProjects });
    expect(resolution.kind).toBe("ambiguous");
  });

  it("returns ambiguous for a multi-project board with no readable location", () => {
    // No location field to disambiguate the filter board's projects, no override.
    const listProjects = JSON.stringify({
      projects: [{ key: "CABB" }, { key: "ESD" }],
    });
    const resolution = resolveProjectKey({ boardGet: "{}", listProjects });
    expect(resolution.kind).toBe("ambiguous");
  });

  it("returns ambiguous for a board that lists no projects", () => {
    const resolution = resolveProjectKey({
      boardGet: JSON.stringify({ location: "X (Y)" }),
      listProjects: JSON.stringify({ projects: [] }),
    });
    expect(resolution.kind).toBe("ambiguous");
  });

  it("degrades to ambiguous rather than throwing on unparseable listProjects output", () => {
    // An acli hiccup (non-JSON stdout) must not crash the pure resolver — it
    // reads as "no projects listed", same as the sibling parsers' "not json" cases.
    const resolution = resolveProjectKey({
      boardGet: JSON.stringify({ location: "X (Y)" }),
      listProjects: "not json",
    });
    expect(resolution.kind).toBe("ambiguous");
  });

  it("degrades to ambiguous rather than throwing on unparseable board get output", () => {
    // A multi-project board whose `board get` output is unparseable has no
    // location to disambiguate with — same outcome as a missing location field.
    const listProjects = JSON.stringify({
      projects: [
        { key: "CABB", name: "Culture Amp Bug Board" },
        { key: "ESD", name: "Team Survey Design" },
      ],
    });
    const resolution = resolveProjectKey({ boardGet: "not json", listProjects });
    expect(resolution.kind).toBe("ambiguous");
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
