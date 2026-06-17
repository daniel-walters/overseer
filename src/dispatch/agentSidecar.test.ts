import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createAgentSidecar } from "./agentSidecar.js";

/**
 * The agent sidecar is the operational-state counterpart to the failed-set: a
 * small deep module mapping `issueKey → handle`, persisted as JSON beside the
 * dispatch failure log (outside the watched root, ADR 0008). It is tested
 * against a real temp file — the persistence *is* the behaviour — mirroring how
 * the failure-log half of the spawn edge is tested. No real Claude is involved.
 */
describe("createAgentSidecar", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-sidecar-"));
    path = join(dir, "state", "agents.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a recorded issueKey → handle (no pass)", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123" },
    });
  });

  it("round-trips a recorded handle *and* review pass", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "abc123", 2);

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123", reviewPass: 2 },
    });
  });

  it("creates the sidecar's parent directory on first record", () => {
    expect(existsSync(join(dir, "state"))).toBe(false);
    createAgentSidecar(path).record("checkout/001-cart.md", "abc123");
    expect(existsSync(path)).toBe(true);
  });

  it("reads an empty map when the sidecar file does not exist", () => {
    expect(createAgentSidecar(path).read()).toEqual({});
  });

  it("keeps distinct Issues' handles side by side", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "handle-a");
    sidecar.record("checkout/002-pay.md", "handle-b");

    expect(sidecar.read()).toEqual({
      "checkout/001-cart.md": { handle: "handle-a" },
      "checkout/002-pay.md": { handle: "handle-b" },
    });
  });

  it("records correctly when the method is destructured (the caller wiring)", () => {
    // The dispatch edge pulls `record` off the object, so it must not depend on
    // a `this` binding back to `read`.
    const { record } = createAgentSidecar(path);
    record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123" },
    });
  });

  it("overwrites an Issue's handle when it is re-recorded (re-dispatch)", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "stale");
    sidecar.record("checkout/001-cart.md", "fresh");

    expect(sidecar.read()).toEqual({ "checkout/001-cart.md": { handle: "fresh" } });
  });

  // A corrupt sidecar — a crash mid-write, a hand-edit, or a non-object value —
  // must read as an empty map (never throw), so the liveness join stays total and
  // `record` can self-heal by overwriting the bad file. Without this, the throw
  // would be swallowed by `record`'s best-effort caller and silently wedge every
  // later spawn against the same unparseable file.
  function plant(contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  it("reads an empty map when the sidecar holds malformed JSON", () => {
    plant('{"checkout/001-cart.md": "abc123'); // truncated mid-write
    expect(createAgentSidecar(path).read()).toEqual({});
  });

  it("reads an empty map when the sidecar holds a non-object JSON value", () => {
    plant("null");
    expect(createAgentSidecar(path).read()).toEqual({});

    plant('"just a string"');
    expect(createAgentSidecar(path).read()).toEqual({});

    plant('["an", "array"]');
    expect(createAgentSidecar(path).read()).toEqual({});
  });

  it("drops malformed entries with no usable handle, keeping the valid ones", () => {
    // A hand-edit / partial corruption can leave a value that is neither a legacy
    // string nor an object with a string handle. Such an entry is dropped (not cast
    // through), so a non-string handle never reaches the liveness join — exactly
    // like parseLiveSet dropping a non-string `id`. A legacy bare string and a
    // well-formed object both survive.
    plant(
      JSON.stringify({
        "checkout/001-cart.md": "abc123", // legacy bare string → { handle }
        "checkout/002-pay.md": 42, // number → dropped
        "checkout/003-x.md": { nested: true }, // object, no string handle → dropped
        "checkout/004-y.md": { handle: "def456", reviewPass: 1 }, // well-formed → kept
        "checkout/005-z.md": { handle: 99 }, // non-string handle → dropped
      }),
    );
    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123" },
      "checkout/004-y.md": { handle: "def456", reviewPass: 1 },
    });
  });

  it("reads a legacy bare-string entry as a handle with no recorded pass", () => {
    // Entries written before the sidecar carried a pass are bare strings. They
    // must read as `{ handle }` — a handle, no pass — never an error and never a
    // false default count, so a board that upgraded mid-flight still joins them.
    plant('{"checkout/001-cart.md": "legacy-handle"}');
    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "legacy-handle" },
    });
  });

  it("reads a missing reviewPass as absent — distinct from a recorded 0", () => {
    // Absent must never coerce to a default like 0 that would render a false `0/cap`
    // marker; it stays absent, distinguishable from an honestly-recorded 0.
    plant(
      JSON.stringify({
        "checkout/001-cart.md": { handle: "h1" }, // no pass → absent
        "checkout/002-pay.md": { handle: "h2", reviewPass: 0 }, // recorded 0
      }),
    );
    const map = createAgentSidecar(path).read();
    const noPass = map["checkout/001-cart.md"]!;
    const recordedZero = map["checkout/002-pay.md"]!;
    expect(noPass.reviewPass).toBeUndefined();
    expect("reviewPass" in noPass).toBe(false);
    expect(recordedZero.reviewPass).toBe(0);
  });

  it("ignores a non-number reviewPass, keeping the handle", () => {
    // A hand-edited / partially-corrupt pass (a string, null, NaN) must not throw
    // and must not render a marker — the handle survives, the pass reads as absent.
    plant(
      JSON.stringify({
        "checkout/001-cart.md": { handle: "h1", reviewPass: "two" },
        "checkout/002-pay.md": { handle: "h2", reviewPass: null },
      }),
    );
    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "h1" },
      "checkout/002-pay.md": { handle: "h2" },
    });
  });

  it("round-trips the pass across a board restart (a fresh sidecar instance)", () => {
    // Reopening the board builds a new sidecar over the same file; the in-flight
    // pass recovers from disk rather than resetting (PRD: recover the count on
    // restart).
    createAgentSidecar(path).record("checkout/001-cart.md", "abc123", 3);
    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123", reviewPass: 3 },
    });
  });

  it("re-recording without a pass clears a previously-recorded pass", () => {
    // A re-dispatch (no pass) overwrites the whole entry, so a stale review pass
    // does not linger on an Issue that is no longer in a review pass.
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "h1", 2);
    sidecar.record("checkout/001-cart.md", "h1");

    expect(sidecar.read()).toEqual({ "checkout/001-cart.md": { handle: "h1" } });
  });

  it("self-heals: record overwrites a corrupt sidecar with a fresh map", () => {
    plant("}{ not json");
    const { record } = createAgentSidecar(path);

    // record reads the corrupt file (as empty), then writes a clean map over it.
    record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": { handle: "abc123" },
    });
  });
});
