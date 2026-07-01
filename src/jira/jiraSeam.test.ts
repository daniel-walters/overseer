import { describe, it, expect } from "vitest";
import {
  parseBoardProject,
  parseWorkItemStatus,
  parseCreatedKey,
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

describe("parseWorkItemStatus", () => {
  it("reads the status name from `workitem view --fields status --json`", () => {
    // The real acli shape: the status name lives at fields.status.name.
    const json = JSON.stringify({
      key: "DS-156",
      fields: { status: { id: "3", name: "In Progress" } },
    });
    expect(parseWorkItemStatus(json)).toBe("In Progress");
  });

  it("returns undefined when the status name is missing or output is bad", () => {
    expect(parseWorkItemStatus(JSON.stringify({ fields: {} }))).toBeUndefined();
    expect(parseWorkItemStatus("nope")).toBeUndefined();
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
