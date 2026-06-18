import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  createFailedSet,
  recordingLogFailure,
  suppressedSeam,
} from "./failedSet.js";
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

  it("records and reports the resolve edge (a transient merge failure)", () => {
    // The resolve edge (ADR 0019) joins the two spawn edges in the same set: a
    // transient merge failure is suppressed this session exactly as a spawn-launch
    // failure is, keyed by `(issueKey, "resolve")`.
    const failed = createFailedSet();
    failed.record("/root/prd/001-rev.md", "resolve");
    expect(failed.has("/root/prd/001-rev.md", "resolve")).toBe(true);
  });

  it("keys the resolve edge apart from the spawn edges for the same Issue", () => {
    // A failed resolve must not suppress the implementor/reviewer edges of the
    // same Issue, nor vice versa — each edge stands alone.
    const failed = createFailedSet();
    failed.record("/root/prd/001-rev.md", "resolve");
    expect(failed.has("/root/prd/001-rev.md", "implementor")).toBe(false);
    expect(failed.has("/root/prd/001-rev.md", "reviewer")).toBe(false);

    failed.record("/root/prd/002-go.md", "reviewer");
    expect(failed.has("/root/prd/002-go.md", "resolve")).toBe(false);
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

describe("suppressedSeam", () => {
  it("reports a recorded (path, edge) as suppressed", () => {
    const failed = createFailedSet();
    failed.record("/root/alpha/001-go.md", "implementor");

    const isSuppressed = suppressedSeam(failed);
    expect(isSuppressed("/root/alpha/001-go.md", "implementor")).toBe(true);
  });

  it("reports an unrecorded (path, edge) as not suppressed", () => {
    const failed = createFailedSet();
    failed.record("/root/alpha/001-go.md", "implementor");

    const isSuppressed = suppressedSeam(failed);
    expect(isSuppressed("/root/alpha/002-other.md", "implementor")).toBe(false);
  });

  it("does not report the other edge of a recorded path as suppressed", () => {
    const failed = createFailedSet();
    failed.record("/root/alpha/001-go.md", "implementor");

    const isSuppressed = suppressedSeam(failed);
    // A path suppressed on implementor is not reported on reviewer…
    expect(isSuppressed("/root/alpha/001-go.md", "reviewer")).toBe(false);

    // …and vice versa.
    failed.record("/root/alpha/001-go.md", "reviewer");
    failed.record("/root/alpha/003-rev.md", "reviewer");
    expect(isSuppressed("/root/alpha/003-rev.md", "implementor")).toBe(false);
    expect(isSuppressed("/root/alpha/003-rev.md", "reviewer")).toBe(true);
  });

  it("is total: an empty set yields false for every query and never throws", () => {
    const isSuppressed = suppressedSeam(createFailedSet());
    expect(isSuppressed("/root/alpha/001-go.md", "implementor")).toBe(false);
    expect(isSuppressed("/root/alpha/001-go.md", "reviewer")).toBe(false);
    expect(isSuppressed("", "implementor")).toBe(false);
  });

  it("reflects records made after the seam was built (it is a live projection)", () => {
    const failed = createFailedSet();
    const isSuppressed = suppressedSeam(failed);

    expect(isSuppressed("/root/alpha/001-go.md", "implementor")).toBe(false);
    failed.record("/root/alpha/001-go.md", "implementor");
    expect(isSuppressed("/root/alpha/001-go.md", "implementor")).toBe(true);
  });

  it("does not expose the writable record method on the seam", () => {
    const isSuppressed = suppressedSeam(createFailedSet());
    // The seam is a bare function: it carries no `record` (or any) property
    // through which the board could mutate the failed-set.
    expect(typeof isSuppressed).toBe("function");
    expect((isSuppressed as unknown as Record<string, unknown>).record).toBe(
      undefined,
    );
  });
});
