import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollBackOrphan, createRollback } from "./rollback.js";
import type { DispatchIssue } from "./reader.js";

/** A minimal orphan DispatchIssue in a given active status. */
function orphan(status: string, overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: overrides.id ?? "001-a.md",
    title: overrides.title ?? "001-a.md",
    path: overrides.path ?? "/root/prd/001-a.md",
    status,
    blockedBy: [],
    repo: "/repos/api",
    worktree: undefined,
    branch: undefined,
    deviation: undefined,
    body: "",
    ...overrides,
  };
}

/** A recording status-writer fake — no real filesystem. */
function recorder() {
  const writes: [string, string][] = [];
  return {
    writes,
    writeStatus: (path: string, status: string) => writes.push([path, status]),
  };
}

describe("rollBackOrphan", () => {
  it("rolls an in-progress orphan back to ready-for-agent through the status seam", () => {
    const rec = recorder();
    const outcome = rollBackOrphan(
      orphan("in-progress", { path: "/root/prd/001-a.md" }),
      { writeStatus: rec.writeStatus },
    );

    expect(outcome).toBe("rolled-back");
    expect(rec.writes).toEqual([["/root/prd/001-a.md", "ready-for-agent"]]);
  });

  it("rolls an in-review orphan back to ready-for-review through the status seam", () => {
    const rec = recorder();
    const outcome = rollBackOrphan(
      orphan("in-review", { path: "/root/prd/002-b.md" }),
      { writeStatus: rec.writeStatus },
    );

    expect(outcome).toBe("rolled-back");
    expect(rec.writes).toEqual([["/root/prd/002-b.md", "ready-for-review"]]);
  });

  it("leaves a non-active Issue untouched and reports it advanced — nothing to roll back to", () => {
    const rec = recorder();
    // ready-for-agent / done are not active statuses: a card that already left
    // the active lane (its agent finished, or another edge advanced it) has
    // nothing to roll back, and reports `advanced` so the UI can say so rather
    // than clobber the new status.
    expect(rollBackOrphan(orphan("ready-for-agent"), { writeStatus: rec.writeStatus })).toBe("advanced");
    expect(rollBackOrphan(orphan("done"), { writeStatus: rec.writeStatus })).toBe("advanced");
    expect(
      rollBackOrphan(orphan(undefined as unknown as string), {
        writeStatus: rec.writeStatus,
      }),
    ).toBe("advanced");

    expect(rec.writes).toEqual([]);
  });
});

describe("createRollback (against a writable temp root)", () => {
  let root: string;

  /** Write one Issue file with the given status into a PRD dir under root. */
  function seedIssue(prdId: string, fileName: string, status: string): void {
    const prdDir = join(root, prdId);
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, "prd.md"), "---\ntitle: A PRD\n---\nbody\n");
    writeFileSync(
      join(prdDir, fileName),
      `---\ntitle: An Issue\nstatus: ${status}\nrepo: /repos/api\n---\nbody\n`,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-rollback-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rolls an in-progress orphan back to ready-for-agent on disk", () => {
    seedIssue("auth", "001-login.md", "in-progress");
    const rb = createRollback(root);

    const preview = rb.readRollback("auth", "001-login.md");
    if (!preview) throw new Error("expected a preview");
    expect(rb.rollback(preview)).toBe("rolled-back");

    const after = readFileSync(join(root, "auth", "001-login.md"), "utf8");
    expect(after).toContain("status: ready-for-agent");
    expect(after).not.toContain("in-progress");
  });

  it("re-reads disk on confirm: a status that advanced under the modal is NOT clobbered", () => {
    // The orphan marker was stale — the agent was alive and finished. Between
    // `R` (readRollback) and confirm (rollback), the on-disk status advances to
    // ready-for-review. The rollback must re-read disk and leave it alone, not
    // overwrite it back to a frontier from the frozen `in-progress` (ADR 0009).
    seedIssue("auth", "001-login.md", "in-progress");
    const rb = createRollback(root);

    const preview = rb.readRollback("auth", "001-login.md");
    if (!preview) throw new Error("expected a preview");

    // The still-live agent advances the Issue under the open modal.
    writeFileSync(
      join(root, "auth", "001-login.md"),
      "---\ntitle: An Issue\nstatus: ready-for-review\nrepo: /repos/api\n---\nbody\n",
    );

    expect(rb.rollback(preview)).toBe("advanced");

    const after = readFileSync(join(root, "auth", "001-login.md"), "utf8");
    expect(after).toContain("status: ready-for-review");
    expect(after).not.toContain("ready-for-agent");
  });

  it("re-reads disk on confirm: an in-review orphan still in-review rolls to ready-for-review", () => {
    seedIssue("auth", "002-pay.md", "in-review");
    const rb = createRollback(root);

    const preview = rb.readRollback("auth", "002-pay.md");
    if (!preview) throw new Error("expected a preview");
    expect(rb.rollback(preview)).toBe("rolled-back");

    const after = readFileSync(join(root, "auth", "002-pay.md"), "utf8");
    expect(after).toContain("status: ready-for-review");
  });

  it("reports a vanished Issue on confirm (deleted under the modal)", () => {
    seedIssue("auth", "003-x.md", "in-progress");
    const rb = createRollback(root);

    const preview = rb.readRollback("auth", "003-x.md");
    if (!preview) throw new Error("expected a preview");

    rmSync(join(root, "auth", "003-x.md"));
    expect(rb.rollback(preview)).toBe("vanished");
  });

  it("returns no preview for a vanished Issue (raced a deletion)", () => {
    const rb = createRollback(root);
    expect(rb.readRollback("auth", "404.md")).toBeUndefined();
  });
});
