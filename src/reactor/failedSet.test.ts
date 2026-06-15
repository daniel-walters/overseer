import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createFailedSet, recordingLogFailure } from "./failedSet.js";
import type { FailureRecord } from "../dispatch/failureLog.js";

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

describe("recordingLogFailure", () => {
  const record = (overrides: Partial<FailureRecord> = {}): FailureRecord => ({
    issueId: "001-go.md",
    repo: "/repos/alpha",
    error: "boom",
    edge: "implementor",
    ...overrides,
  });

  it("records the failure into the set keyed by the Issue's full path and edge", () => {
    const failed = createFailedSet();
    const wrapped = recordingLogFailure(failed, "/root/alpha", () => {});

    wrapped(record());

    // The bare filename is re-joined with prdDir to form the full-path key.
    expect(failed.has(join("/root/alpha", "001-go.md"), "implementor")).toBe(true);
    // Not under the other edge, nor under the bare filename alone.
    expect(failed.has(join("/root/alpha", "001-go.md"), "reviewer")).toBe(false);
    expect(failed.has("001-go.md", "implementor")).toBe(false);
  });

  it("delegates the record to the wrapped logFailure unchanged", () => {
    const failed = createFailedSet();
    const logged: FailureRecord[] = [];
    const wrapped = recordingLogFailure(failed, "/root/alpha", (r) =>
      logged.push(r),
    );

    const r = record({ edge: "reviewer" });
    wrapped(r);

    expect(logged).toEqual([r]);
    expect(failed.has(join("/root/alpha", "001-go.md"), "reviewer")).toBe(true);
  });
});
