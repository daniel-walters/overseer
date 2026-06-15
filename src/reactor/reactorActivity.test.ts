import { describe, it, expect } from "vitest";
import { deriveActivity, type ReactorActivity } from "./reactorActivity.js";

/**
 * The board-level idle / working / at-rest signal (Issue: surface reactor state)
 * is derived purely from two pieces of in-memory reactor state: whether auto-run
 * is enabled, and whether the most recent reconcile spawned anything. It is the
 * second reactor-state overlay, alongside the per-card suppressed marker — and,
 * like it, never written to the watched root (ADR 0002, ADR 0011): it is computed
 * from the live Reactor, not from disk.
 *
 * The signal is deliberately *separate* from the auto-run on/off indicator: an
 * idle on-Reactor and an off one both leave the board still (CONTEXT.md →
 * Reactor → Visibility), so on top of "is auto-run on?" the operator needs "is it
 * actually doing anything?". Three states answer that:
 *
 * - **at-rest** — auto-run is off, so the Reactor will spawn nothing until it is
 *   re-enabled. The board being still is *expected*; this is the quiesced state.
 * - **working** — auto-run is on and the last reconcile spawned at least one
 *   agent: the Reactor is actively driving the pipeline forward.
 * - **idle** — auto-run is on but the last reconcile spawned nothing: the board
 *   is still because there is genuinely nothing eligible right now, not because
 *   the Reactor is braked.
 */
describe("deriveActivity", () => {
  it("is at-rest whenever auto-run is disabled, regardless of last spawn", () => {
    // Off is off: even if the previous (enabled) reconcile spawned work, once
    // auto-run is disabled the Reactor will start nothing, so the board's stillness
    // is the expected at-rest state, never mislabelled idle/working.
    expect(deriveActivity({ enabled: false, spawnedLastReconcile: false })).toBe(
      "at-rest" satisfies ReactorActivity,
    );
    expect(deriveActivity({ enabled: false, spawnedLastReconcile: true })).toBe(
      "at-rest" satisfies ReactorActivity,
    );
  });

  it("is working when auto-run is on and the last reconcile spawned", () => {
    expect(deriveActivity({ enabled: true, spawnedLastReconcile: true })).toBe(
      "working" satisfies ReactorActivity,
    );
  });

  it("is idle when auto-run is on and the last reconcile spawned nothing", () => {
    expect(deriveActivity({ enabled: true, spawnedLastReconcile: false })).toBe(
      "idle" satisfies ReactorActivity,
    );
  });
});
