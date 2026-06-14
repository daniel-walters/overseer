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
    rollBackOrphan(orphan("in-progress", { path: "/root/prd/001-a.md" }), {
      writeStatus: rec.writeStatus,
    });

    expect(rec.writes).toEqual([["/root/prd/001-a.md", "ready-for-agent"]]);
  });

  it("rolls an in-review orphan back to ready-for-review through the status seam", () => {
    const rec = recorder();
    rollBackOrphan(orphan("in-review", { path: "/root/prd/002-b.md" }), {
      writeStatus: rec.writeStatus,
    });

    expect(rec.writes).toEqual([["/root/prd/002-b.md", "ready-for-review"]]);
  });

  it("leaves a non-active Issue untouched — no awaiting target to roll back to", () => {
    const rec = recorder();
    // ready-for-agent is not an active status: a card that already sits on its
    // frontier has nothing to roll back. (The UI gates R on the orphan marker;
    // this is the edge's own defensive guard.)
    rollBackOrphan(orphan("ready-for-agent"), { writeStatus: rec.writeStatus });
    rollBackOrphan(orphan("done"), { writeStatus: rec.writeStatus });
    rollBackOrphan(orphan(undefined as unknown as string), {
      writeStatus: rec.writeStatus,
    });

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
    rb.rollback(preview);

    const after = readFileSync(join(root, "auth", "001-login.md"), "utf8");
    expect(after).toContain("status: ready-for-agent");
    expect(after).not.toContain("in-progress");
  });

  it("returns no preview for a vanished Issue (raced a deletion)", () => {
    const rb = createRollback(root);
    expect(rb.readRollback("auth", "404.md")).toBeUndefined();
  });
});
