import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactor, type ReactorDeps } from "./reactor.js";
import { createFailedSet, suppressedSeam } from "./failedSet.js";
import { createRollback } from "../dispatch/rollback.js";
import { scanBoard } from "../scanner.js";
import type { GitSeam } from "../dispatch/gitSetup.js";
import type { Issue } from "../model.js";

/** Find the one Issue with `id` in a scanned PRD's issues, or throw. */
function issueById(issues: readonly Issue[], id: string): Issue {
  const found = issues.find((i) => i.id === id);
  if (!found) throw new Error(`no issue ${id}`);
  return found;
}

/** Find the one PRD with `id` in a scanned board, or throw. */
function prdIssues(
  board: ReturnType<typeof scanBoard>,
  id: string,
): readonly Issue[] {
  const prd = board.prds.find((p) => p.id === id);
  if (!prd) throw new Error(`no prd ${id}`);
  return prd.issues;
}

/**
 * Gap 1 of "surface reactor state": an orphan re-dispatch (`R`, ADR 0009) whose
 * relaunch then fails to launch must surface the `⊘ suppressed` marker, exactly
 * as any other spawn-failure suppression does.
 *
 * The mechanism already exists end to end (ADR 0009 left this case to "surface
 * reactor state"; ADR 0011 built the failed-set + marker): `R` rolls the orphan
 * `in-progress → ready-for-agent`, the normal spawn edge (here the Reactor)
 * re-picks it up, and if that relaunch throws, the spawn edge rolls it back to
 * `ready-for-agent` and records `(path, implementor)` into the *shared*
 * failed-set. The scanner, joining the failed-set's read projection onto the
 * `ready-for-agent` lane, then stamps the marker. These tests pin that whole path
 * so the orphan-recovery case can't silently regress back to an invisible
 * launch-failed card.
 */
describe("orphan re-dispatch that fails to launch surfaces the suppressed marker", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-orphan-suppressed-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeGit(): GitSeam {
    return {
      isGitRepo: vi.fn(() => true),
      defaultBase: vi.fn(() => "origin/main"),
      branchExists: vi.fn(() => true),
      createBranch: vi.fn(),
      checkoutBranch: vi.fn(),
    };
  }

  const fm = (fields: Record<string, string>): string =>
    `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n\nbody\n`;

  function writePrd(name: string, issues: Record<string, string>): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prd.md"), `---\ntitle: ${name}\n---\n\nBody.\n`);
    for (const [file, contents] of Object.entries(issues)) {
      writeFileSync(join(dir, file), contents);
    }
  }

  function failingReactorDeps(failedSet: ReturnType<typeof createFailedSet>): ReactorDeps {
    return {
      git: fakeGit(),
      // The relaunch throws at the `claude --bg` tip, exactly as a transient
      // launch failure (bad binary / git hiccup) would.
      spawn: () => {
        throw new Error("claude: command not found");
      },
      logFailure: () => {},
      recordHandle: () => {},
      failedSet,
    };
  }

  it("an orphaned in-progress Issue, rolled back by R then failing to relaunch, carries the marker", () => {
    // The orphan: stuck in-progress, its agent gone.
    writePrd("alpha", {
      "001-stuck.md": fm({ status: "in-progress", repo: "/repos/alpha" }),
    });
    const file = join(root, "alpha", "001-stuck.md");

    const failedSet = createFailedSet();

    // `R` rolls the orphan back onto its frontier (in-progress → ready-for-agent),
    // spawning nothing — the normal spawn edge re-picks it up.
    const rollback = createRollback(root);
    const preview = rollback.readRollback("alpha", "001-stuck.md");
    if (!preview) throw new Error("expected a re-dispatch preview");
    expect(rollback.rollback(preview)).toBe("rolled-back");
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-agent");

    // The Reactor (sharing the failed-set) re-picks it up — and the relaunch
    // throws. It rolls back to ready-for-agent and records the failure.
    createReactor(root, failingReactorDeps(failedSet)).reconcile();
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-agent");
    expect(failedSet.has(file, "implementor")).toBe(true);

    // The board, joining the failed-set's read projection, stamps the marker on
    // the (still ready-for-agent) card — no longer an invisible launch-failed card.
    const board = scanBoard(root, undefined, suppressedSeam(failedSet));
    const issue = issueById(prdIssues(board, "alpha"), "001-stuck.md");
    expect(issue.suppressed).toBe(true);
  });

  it("an orphaned in-audit Issue, rolled back then failing to relaunch, carries the marker on the audit edge", () => {
    // The audit-edge twin (ADR 0026): an in-audit orphan rolls back to
    // ready-for-audit and its failed auditor relaunch suppresses the audit edge.
    // The auditor needs the recorded worktree the implementor left, so the orphan
    // carries one (an in-audit Issue always does).
    writePrd("alpha", {
      "001-aud.md": fm({
        status: "in-audit",
        repo: "/repos/alpha",
        worktree: "/wt/x",
      }),
    });
    const file = join(root, "alpha", "001-aud.md");

    const failedSet = createFailedSet();

    const rollback = createRollback(root);
    const preview = rollback.readRollback("alpha", "001-aud.md");
    if (!preview) throw new Error("expected a re-dispatch preview");
    expect(rollback.rollback(preview)).toBe("rolled-back");
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-audit");

    createReactor(root, failingReactorDeps(failedSet)).reconcile();
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-audit");
    expect(failedSet.has(file, "audit")).toBe(true);

    const board = scanBoard(root, undefined, suppressedSeam(failedSet));
    const issue = issueById(prdIssues(board, "alpha"), "001-aud.md");
    expect(issue.suppressed).toBe(true);
  });

  it("an orphaned in-review Issue, rolled back then failing to relaunch, carries the marker on the reviewer edge", () => {
    // The review-edge twin: an in-review orphan rolls back to ready-for-review and
    // its failed reviewer relaunch suppresses the reviewer edge.
    writePrd("alpha", {
      "001-rev.md": fm({
        status: "in-review",
        repo: "/repos/alpha",
        worktree: "/wt/x",
        branch: "b",
      }),
    });
    const file = join(root, "alpha", "001-rev.md");

    const failedSet = createFailedSet();

    const rollback = createRollback(root);
    const preview = rollback.readRollback("alpha", "001-rev.md");
    if (!preview) throw new Error("expected a re-dispatch preview");
    expect(rollback.rollback(preview)).toBe("rolled-back");
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-review");

    createReactor(root, failingReactorDeps(failedSet)).reconcile();
    expect(readFileSync(file, "utf8")).toContain("status: ready-for-review");
    expect(failedSet.has(file, "reviewer")).toBe(true);

    const board = scanBoard(root, undefined, suppressedSeam(failedSet));
    const issue = issueById(prdIssues(board, "alpha"), "001-rev.md");
    expect(issue.suppressed).toBe(true);
  });
});
