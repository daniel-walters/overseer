import { describe, it, expect, vi } from "vitest";
import { runDispatch, type DispatchDeps } from "./dispatch.js";
import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";

/** A minimal DispatchIssue for a frontier entry under test. */
function issue(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    path: overrides.path ?? `/root/prd/${overrides.id ?? "001-a.md"}`,
    status: overrides.status ?? "ready-for-agent",
    blockedBy: overrides.blockedBy ?? [],
    repo: overrides.repo ?? "/repos/backend",
    body: overrides.body ?? "",
  };
}

function entry(
  classification: FrontierEntry["classification"],
  overrides: Partial<DispatchIssue> = {},
): FrontierEntry {
  return { issue: issue(overrides), classification };
}

/** Seams that record what the dispatch did, with no real fs or process. */
function deps(): DispatchDeps & { writes: [string, string][]; spawns: DispatchIssue[] } {
  const writes: [string, string][] = [];
  const spawns: DispatchIssue[] = [];
  return {
    writes,
    spawns,
    writeStatus: (path, status) => writes.push([path, status]),
    spawn: (issue) => spawns.push(issue),
  };
}

describe("runDispatch", () => {
  it("flips each spawn candidate to in-progress, then spawns it", () => {
    const d = deps();
    runDispatch(
      [
        entry("spawn", { id: "001-a.md", path: "/root/prd/001-a.md" }),
        entry("spawn", { id: "002-b.md", path: "/root/prd/002-b.md" }),
      ],
      d,
    );

    expect(d.writes).toEqual([
      ["/root/prd/001-a.md", "in-progress"],
      ["/root/prd/002-b.md", "in-progress"],
    ]);
    expect(d.spawns.map((i) => i.id)).toEqual(["001-a.md", "002-b.md"]);
  });

  it("flips a candidate's status before spawning it", () => {
    const order: string[] = [];
    runDispatch([entry("spawn", { id: "001-a.md" })], {
      writeStatus: (_path, status) => order.push(`write:${status}`),
      spawn: () => order.push("spawn"),
    });

    expect(order).toEqual(["write:in-progress", "spawn"]);
  });

  it("ignores queued, blocked, and skipped entries entirely", () => {
    const d = deps();
    runDispatch(
      [
        entry("queued", { id: "001-q.md" }),
        entry("blocked", { id: "002-x.md" }),
        entry("skipped", { id: "003-s.md" }),
      ],
      d,
    );

    expect(d.writes).toEqual([]);
    expect(d.spawns).toEqual([]);
  });

  it("acts only on the spawn candidates within a mixed frontier", () => {
    const d = deps();
    runDispatch(
      [
        entry("skipped", { id: "001-s.md" }),
        entry("spawn", { id: "002-go.md", path: "/root/prd/002-go.md" }),
        entry("queued", { id: "003-q.md" }),
      ],
      d,
    );

    expect(d.writes).toEqual([["/root/prd/002-go.md", "in-progress"]]);
    expect(d.spawns.map((i) => i.id)).toEqual(["002-go.md"]);
  });

  it("does nothing for an empty frontier", () => {
    const writeStatus = vi.fn();
    const spawn = vi.fn();
    runDispatch([], { writeStatus, spawn });
    expect(writeStatus).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
