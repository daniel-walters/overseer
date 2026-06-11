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

  it("round-trips a recorded issueKey → handle", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": "abc123",
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
      "checkout/001-cart.md": "handle-a",
      "checkout/002-pay.md": "handle-b",
    });
  });

  it("records correctly when the method is destructured (the caller wiring)", () => {
    // The dispatch edge pulls `record` off the object, so it must not depend on
    // a `this` binding back to `read`.
    const { record } = createAgentSidecar(path);
    record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": "abc123",
    });
  });

  it("overwrites an Issue's handle when it is re-recorded (re-dispatch)", () => {
    const sidecar = createAgentSidecar(path);
    sidecar.record("checkout/001-cart.md", "stale");
    sidecar.record("checkout/001-cart.md", "fresh");

    expect(sidecar.read()).toEqual({ "checkout/001-cart.md": "fresh" });
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

  it("self-heals: record overwrites a corrupt sidecar with a fresh map", () => {
    plant("}{ not json");
    const { record } = createAgentSidecar(path);

    // record reads the corrupt file (as empty), then writes a clean map over it.
    record("checkout/001-cart.md", "abc123");

    expect(createAgentSidecar(path).read()).toEqual({
      "checkout/001-cart.md": "abc123",
    });
  });
});
