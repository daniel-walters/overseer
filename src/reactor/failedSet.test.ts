import { describe, it, expect } from "vitest";
import { createFailedSet } from "./failedSet.js";

describe("createFailedSet", () => {
  it("does not report an unrecorded Issue as failed on either edge", () => {
    const failed = createFailedSet();
    expect(failed.has("001-go.md", "implementor")).toBe(false);
    expect(failed.has("001-go.md", "reviewer")).toBe(false);
  });

  it("reports a recorded Issue as failed on the edge it was recorded under", () => {
    const failed = createFailedSet();
    failed.record("001-go.md", "implementor");
    expect(failed.has("001-go.md", "implementor")).toBe(true);
  });

  it("keys per edge: an implementor failure does not suppress the reviewer edge", () => {
    const failed = createFailedSet();
    failed.record("001-go.md", "implementor");
    expect(failed.has("001-go.md", "reviewer")).toBe(false);
  });

  it("keys per edge: a reviewer failure does not suppress the implementor edge", () => {
    const failed = createFailedSet();
    failed.record("001-go.md", "reviewer");
    expect(failed.has("001-go.md", "implementor")).toBe(false);
  });

  it("keys per Issue: a failure on one Issue does not suppress another", () => {
    const failed = createFailedSet();
    failed.record("001-go.md", "implementor");
    expect(failed.has("002-other.md", "implementor")).toBe(false);
  });

  it("is idempotent: recording the same (issue, edge) twice stays recorded", () => {
    const failed = createFailedSet();
    failed.record("001-go.md", "implementor");
    failed.record("001-go.md", "implementor");
    expect(failed.has("001-go.md", "implementor")).toBe(true);
  });
});
