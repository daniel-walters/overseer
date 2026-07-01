import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditor, type AuditorDeps } from "./auditor.js";
import { createFailedSet } from "../reactor/failedSet.js";

/** Recording seams so we can assert the spawn invocation shape and logging. */
function recordingDeps(overrides: Partial<AuditorDeps> = {}): AuditorDeps & {
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

/** Write a PRD directory with a prd.md and the given Issue files. */
function writePrd(root: string, name: string, issues: Record<string, string>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prd.md"), `---\ntitle: ${name}\n---\n\nBody of ${name}.\n`);
  for (const [file, contents] of Object.entries(issues)) {
    writeFileSync(join(dir, file), contents);
  }
}

const fm = (fields: Record<string, string>, body = "body"): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

describe("createAuditor", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-auditor-"));
    writePrd(root, "checkout", {
      // ready-for-audit with a recorded worktree + repo ⇒ auditable.
      "001-audit.md": fm({
        title: "Audit me",
        status: "ready-for-audit",
        repo: "/repos/backend",
        worktree: "/Users/x/.worktrees/blue-cat-fox",
        branch: "blue-cat-fox",
      }),
      // ready-for-agent ⇒ not auditable (wrong status).
      "002-agent.md": fm({ status: "ready-for-agent", repo: "/repos/backend" }),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads and classifies the selected Issue's auditability by id", () => {
    const auditor = createAuditor(root, recordingDeps());

    const audit001 = auditor.readAudit("checkout", "001-audit.md");
    expect(audit001?.eligibility.auditable).toBe(true);

    const audit002 = auditor.readAudit("checkout", "002-agent.md");
    expect(audit002?.eligibility.auditable).toBe(false);
  });

  it("returns undefined for an Issue id that isn't in the PRD", () => {
    const auditor = createAuditor(root, recordingDeps());
    expect(auditor.readAudit("checkout", "999-ghost.md")).toBeUndefined();
  });

  it("flips the auditable Issue to in-audit on disk and spawns it in its repo", () => {
    const deps = recordingDeps();
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    const after = readFileSync(join(root, "checkout", "001-audit.md"), "utf8");
    expect(after).toContain("status: in-audit");

    expect(deps.spawns).toHaveLength(1);
    expect(deps.spawns[0]?.repo).toBe("/repos/backend");
  });

  it("records the auditor's handle against the Issue's full path", () => {
    const deps = recordingDeps();
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    expect(deps.handles).toEqual([
      {
        issueKey: join(root, "checkout", "001-audit.md"),
        handle: "handle-/repos/backend",
      },
    ]);
  });

  it("builds a prompt carrying the worktree and the PRD body", () => {
    const deps = recordingDeps();
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    const prompt = deps.spawns[0]?.prompt ?? "";
    expect(prompt).toContain("blue-cat-fox"); // recorded worktree
    expect(prompt).toContain("Body of checkout."); // PRD body the diff is judged against
  });

  it("rolls the Issue back to ready-for-audit and logs under the audit edge when the spawn fails", () => {
    const deps = recordingDeps({
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    const after = readFileSync(join(root, "checkout", "001-audit.md"), "utf8");
    expect(after).toContain("status: ready-for-audit");
    expect(after).not.toContain("in-audit");

    expect(deps.failures).toEqual([
      {
        issueId: "001-audit.md",
        repo: "/repos/backend",
        error: "claude: command not found",
        edge: "audit",
      },
    ]);
  });

  it("records a failed manual c launch into the shared failed-set under the audit edge", () => {
    // A manual `c` launch failure lands in the same session-scoped failed-set the
    // Reactor reads, keyed by the Issue's full path under the `audit` edge — so the
    // next reconcile suppresses its audit spawn exactly as an automated failure
    // would (ADR 0011 / 0026), without masking the implementor edge.
    const failedSet = createFailedSet();
    const deps = recordingDeps({
      failedSet,
      spawn: () => {
        throw new Error("claude: command not found");
      },
    });
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    const path = join(root, "checkout", "001-audit.md");
    expect(failedSet.has(path, "audit")).toBe(true);
    expect(failedSet.has(path, "implementor")).toBe(false);
  });

  it("does not touch the failed-set when a manual c launch succeeds", () => {
    const failedSet = createFailedSet();
    const deps = recordingDeps({ failedSet });
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    const path = join(root, "checkout", "001-audit.md");
    expect(failedSet.has(path, "audit")).toBe(false);
  });

  it("does not spawn or flip an ineligible Issue even if audit is called", () => {
    const deps = recordingDeps();
    const auditor = createAuditor(root, deps);

    // 002 is ready-for-agent (not auditable); audit must spawn nothing.
    const preview = auditor.readAudit("checkout", "002-agent.md");
    if (!preview) throw new Error("expected a preview");
    auditor.audit(preview);

    expect(deps.spawns).toEqual([]);
    const after = readFileSync(join(root, "checkout", "002-agent.md"), "utf8");
    expect(after).not.toContain("in-audit");
  });

  it("does not flip or spawn a candidate whose file vanished after the preview", () => {
    const deps = recordingDeps();
    const auditor = createAuditor(root, deps);

    const preview = auditor.readAudit("checkout", "001-audit.md");
    if (!preview) throw new Error("expected a preview");
    rmSync(join(root, "checkout", "001-audit.md"));

    expect(() => auditor.audit(preview)).not.toThrow();
    expect(deps.spawns).toEqual([]);
  });

  it("returns undefined instead of throwing when the PRD dir is gone", () => {
    const auditor = createAuditor(root, recordingDeps());
    expect(() => auditor.readAudit("ghost-prd", "001-a.md")).not.toThrow();
    expect(auditor.readAudit("ghost-prd", "001-a.md")).toBeUndefined();
  });
});
