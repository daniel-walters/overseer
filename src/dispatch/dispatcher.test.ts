import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, type DispatcherDeps } from "./dispatcher.js";
import { createSpawnEdge } from "./spawn.js";
import { createAgentSidecar } from "./agentSidecar.js";
import { createFailedSet } from "../reactor/failedSet.js";
import type { GitSeam } from "./gitSetup.js";

const checkoutFlow = fileURLToPath(
  new URL("./__fixtures__/dispatch/checkout-flow", import.meta.url),
);

/** A git seam that treats every repo as valid with the branch already present. */
function fakeGit(overrides: Partial<GitSeam> = {}): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => "origin/main"),
    branchExists: vi.fn(() => true),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
    ...overrides,
  };
}

/** Recording seams so we can assert the spawn invocation shape and logging. */
function recordingDeps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps & {
  spawns: { repo: string; prompt: string }[];
  failures: unknown[];
  handles: { issueKey: string; handle: string }[];
} {
  const spawns: { repo: string; prompt: string }[] = [];
  const failures: unknown[] = [];
  const handles: { issueKey: string; handle: string }[] = [];
  return {
    spawns,
    failures,
    handles,
    git: fakeGit(),
    spawn: (repo, prompt) => {
      spawns.push({ repo, prompt });
      return `handle-${repo}`;
    },
    logFailure: (r) => failures.push(r),
    recordHandle: (issueKey, handle) => handles.push({ issueKey, handle }),
    failedSet: createFailedSet(),
    ...overrides,
  };
}

describe("createDispatcher", () => {
  it("reads and classifies the selected PRD's frontier by id", () => {
    const root = fileURLToPath(new URL("./__fixtures__/dispatch", import.meta.url));
    const dispatcher = createDispatcher(root, recordingDeps());

    const byId = new Map(
      dispatcher.readFrontier("checkout-flow").map((e) => [e.issue.id, e.classification]),
    );

    // 002 is ready-for-agent with its only blocker (001) done → spawn.
    expect(byId.get("002-payment-intent.md")).toBe("spawn");
    // 003 has no repo → skipped; 001 is done, 004 ready-for-review → skipped.
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

    it("flips the spawn candidate to in-progress on disk and spawns it in its repo", () => {
      const deps = recordingDeps();
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      // 002 was the lone spawn candidate; its file now reads in-progress.
      const after = readFileSync(
        join(root, "checkout-flow", "002-payment-intent.md"),
        "utf8",
      );
      expect(after).toContain("status: in-progress");

      expect(deps.spawns).toHaveLength(1);
      expect(deps.spawns[0]?.repo).toBe("/repos/backend");

      // A skipped Issue's file is untouched.
      const skipped = readFileSync(
        join(root, "checkout-flow", "001-cart-totals.md"),
        "utf8",
      );
      expect(skipped).toContain("status: done");
    });

    it("records the spawned agent's handle against the Issue's full path", () => {
      const deps = recordingDeps();
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      // The handle the spawn returned is recorded against the Issue's full path
      // (prdDir/filename), the join key a later board open intersects with the
      // live `claude agents --json` set (ADR 0008).
      expect(deps.handles).toEqual([
        {
          issueKey: join(root, "checkout-flow", "002-payment-intent.md"),
          handle: "handle-/repos/backend",
        },
      ]);
    });

    it("persists the handle claude --bg printed to the sidecar, end-to-end", () => {
      // The full production chain with only the child-process exec faked: a real
      // spawn edge (parses `backgrounded · <handle>` from the launch stdout) and
      // a real file-backed sidecar. No real Claude is launched.
      const sidecarPath = join(root, "state", "agents.json");
      const { record: recordHandle } = createAgentSidecar(sidecarPath);
      const { spawn, logFailure } = createSpawnEdge({
        exec: () => "backgrounded · session-9c2",
        logPath: join(root, "state", "dispatch.log"),
      });
      const dispatcher = createDispatcher(root, {
        git: fakeGit(),
        spawn,
        logFailure,
        recordHandle,
        failedSet: createFailedSet(),
      });

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      const issueKey = join(root, "checkout-flow", "002-payment-intent.md");
      expect(createAgentSidecar(sidecarPath).read()).toEqual({
        [issueKey]: "session-9c2",
      });
    });

    it("builds a prompt carrying the Issue body, PRD body, repo, and feature branch", () => {
      const deps = recordingDeps();
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      const prompt = deps.spawns[0]?.prompt ?? "";
      expect(prompt).toContain("/repos/backend"); // target repo
      expect(prompt).toContain("checkout-flow"); // slugified PRD dir = feature branch
      expect(prompt).toContain("Let a user pay for the items in their cart"); // PRD body
      expect(prompt).toContain("ready-for-review"); // the completion instruction
      expect(prompt).toContain("002-payment-intent.md"); // the Issue file path
    });

    it("ensures the PRD feature branch in the candidate's repo before spawning", () => {
      const git = fakeGit({ branchExists: vi.fn(() => false) });
      const dispatcher = createDispatcher(root, recordingDeps({ git }));

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      expect(git.createBranch).toHaveBeenCalledWith(
        "/repos/backend",
        "checkout-flow",
        "origin/main",
      );
    });

    it("rolls the Issue back to ready-for-agent and logs when the spawn fails", () => {
      const deps = recordingDeps({
        spawn: () => {
          throw new Error("claude: command not found");
        },
      });
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      // The board stays truthful: the rolled-back Issue is ready-for-agent again.
      const after = readFileSync(
        join(root, "checkout-flow", "002-payment-intent.md"),
        "utf8",
      );
      expect(after).toContain("status: ready-for-agent");
      expect(after).not.toContain("in-progress");

      expect(deps.failures).toEqual([
        {
          issueId: "002-payment-intent.md",
          repo: "/repos/backend",
          error: "claude: command not found",
          edge: "implementor",
        },
      ]);
    });

    it("records a failed manual d launch into the shared failed-set under the implementor edge", () => {
      // The behaviour change (ADR 0011): a manual `d` launch failure now lands in
      // the same session-scoped failed-set the Reactor reads, keyed by the Issue's
      // full path (prdDir/filename) under the implementor edge — so the next
      // reconcile suppresses it exactly as it would an automated failure.
      const failedSet = createFailedSet();
      const deps = recordingDeps({
        failedSet,
        spawn: () => {
          throw new Error("claude: command not found");
        },
      });
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      const path = join(root, "checkout-flow", "002-payment-intent.md");
      expect(failedSet.has(path, "implementor")).toBe(true);
      // The other edge for the same Issue is untouched: a failed `d` does not
      // suppress that Issue's reviewer edge.
      expect(failedSet.has(path, "reviewer")).toBe(false);
    });

    it("does not touch the failed-set when a manual d launch succeeds", () => {
      const failedSet = createFailedSet();
      const deps = recordingDeps({ failedSet });
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      const path = join(root, "checkout-flow", "002-payment-intent.md");
      expect(failedSet.has(path, "implementor")).toBe(false);
    });

    it("skips a candidate whose repo fails validation: not flipped, not spawned", () => {
      const git = fakeGit({ isGitRepo: vi.fn(() => false) });
      const deps = recordingDeps({ git });
      const dispatcher = createDispatcher(root, deps);

      dispatcher.dispatch(dispatcher.readFrontier("checkout-flow"));

      const after = readFileSync(
        join(root, "checkout-flow", "002-payment-intent.md"),
        "utf8",
      );
      // Never moved (acceptance: invalid repo is skipped, not flipped).
      expect(after).toContain("status: ready-for-agent");
      expect(deps.spawns).toEqual([]);
    });

    it("does not flip or spawn a candidate whose file vanished after the preview", () => {
      const deps = recordingDeps();
      const dispatcher = createDispatcher(root, deps);

      const frontier = dispatcher.readFrontier("checkout-flow");
      // The watched root changes under us: the candidate is deleted between
      // opening the preview and confirming.
      rmSync(join(root, "checkout-flow", "002-payment-intent.md"));

      expect(() => dispatcher.dispatch(frontier)).not.toThrow();
      expect(deps.spawns).toEqual([]);
    });
  });

  describe("resilience to a changing watched root", () => {
    it("returns an empty frontier instead of throwing when the PRD dir is gone", () => {
      const root = mkdtempSync(join(tmpdir(), "overseer-dispatcher-"));
      try {
        const dispatcher = createDispatcher(root, recordingDeps());
        expect(() => dispatcher.readFrontier("ghost-prd")).not.toThrow();
        expect(dispatcher.readFrontier("ghost-prd")).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
