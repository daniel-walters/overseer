import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher } from "./dispatcher.js";
import type { DispatchIssue } from "./reader.js";

const checkoutFlow = fileURLToPath(
  new URL("./__fixtures__/dispatch/checkout-flow", import.meta.url),
);

describe("createDispatcher", () => {
  it("reads and classifies the selected PRD's frontier by id", () => {
    // root = the fixtures dir; the PRD id is the directory name under it.
    const root = fileURLToPath(new URL("./__fixtures__/dispatch", import.meta.url));
    const dispatcher = createDispatcher(root, vi.fn());

    const byId = new Map(
      dispatcher.readFrontier("checkout-flow").map((e) => [e.issue.id, e.classification]),
    );

    // 002 is ready-for-agent with its only blocker (001) done → spawn.
    expect(byId.get("002-payment-intent.md")).toBe("spawn");
    // 003 has no repo → skipped; 001 is done, 004 backlog → skipped.
    expect(byId.get("003-checkout-button.md")).toBe("skipped");
    expect(byId.get("001-cart-totals.md")).toBe("skipped");
  });

  describe("dispatch (against a writable copy of the fixture)", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "overseer-dispatcher-"));
      cpSync(checkoutFlow, join(root, "checkout-flow"), { recursive: true });
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("flips each spawn candidate to in-progress on disk and spawns it", () => {
      const spawned: DispatchIssue[] = [];
      const dispatcher = createDispatcher(root, (issue) => spawned.push(issue));

      const frontier = dispatcher.readFrontier("checkout-flow");
      dispatcher.dispatch(frontier);

      // 002 was the lone spawn candidate; its file now reads in-progress.
      const after = readFileSync(
        join(root, "checkout-flow", "002-payment-intent.md"),
        "utf8",
      );
      expect(after).toContain("status: in-progress");
      expect(spawned.map((i) => i.id)).toEqual(["002-payment-intent.md"]);

      // A skipped Issue's file is untouched.
      const skipped = readFileSync(
        join(root, "checkout-flow", "001-cart-totals.md"),
        "utf8",
      );
      expect(skipped).toContain("status: done");
    });

    it("does not flip or spawn a candidate whose file vanished after the preview", () => {
      const spawned: DispatchIssue[] = [];
      const dispatcher = createDispatcher(root, (issue) => spawned.push(issue));

      const frontier = dispatcher.readFrontier("checkout-flow");
      // The watched root changes under us: the spawn candidate is deleted between
      // opening the preview and confirming.
      rmSync(join(root, "checkout-flow", "002-payment-intent.md"));

      // The flip's readFileSync would ENOENT; dispatch must swallow it, not throw.
      expect(() => dispatcher.dispatch(frontier)).not.toThrow();
      // With the flip failed, the agent is never spawned (the flip is its lock).
      expect(spawned).toEqual([]);
    });
  });

  describe("resilience to a changing watched root", () => {
    it("returns an empty frontier instead of throwing when the PRD dir is gone", () => {
      const root = mkdtempSync(join(tmpdir(), "overseer-dispatcher-"));
      try {
        const dispatcher = createDispatcher(root, vi.fn());
        // No such PRD directory under root — a stale selection on a watched root.
        expect(() => dispatcher.readFrontier("ghost-prd")).not.toThrow();
        expect(dispatcher.readFrontier("ghost-prd")).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
