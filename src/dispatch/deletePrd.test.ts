import { describe, it, expect, vi } from "vitest";
import { deletePrdAt, createDelete, type DeleteDeps } from "./deletePrd.js";
import type { DeleteSeam } from "./deletePrd.js";

/**
 * Delete PRD is the board's first destructive write to the watched root (ADR
 * 0016): on a `done` PRD it removes the whole directory — `prd.md`, every Issue
 * file, and any other file — wholesale. The orchestration is the deep module: it
 * builds a preview (title + Issue-file count) and, on confirm, removes the
 * directory through the injectable {@link DeleteSeam}, so every branch is
 * unit-tested with an in-memory fake and no real `fs.rmSync` (prior art:
 * `openPr.test.ts`'s `FakePrSeam`).
 *
 * A scriptable stand-in for the real `fs.rmSync` seam: it records every
 * `removeDir` call and can be scripted to make the removal throw (a permissions
 * failure) — the only edge the orchestration drives.
 */
class FakeDeleteSeam implements DeleteSeam {
  /** Dirs whose `removeDir` should throw, simulating a permissions failure. */
  readonly failRemove = new Set<string>();

  readonly removeDir = vi.fn((path: string) => {
    if (this.failRemove.has(path)) throw new Error(`EACCES: ${path}`);
  });
}

const PRD_DIR = "/root/Auth System";

function deps(overrides: Partial<DeleteDeps> = {}): DeleteDeps {
  return {
    seam: new FakeDeleteSeam(),
    countIssues: () => 3,
    ...overrides,
  };
}

describe("deletePrdAt", () => {
  it("removes the whole PRD directory through the seam", () => {
    const seam = new FakeDeleteSeam();
    const d = deps({ seam });

    const result = deletePrdAt(PRD_DIR, d);

    expect(result.ok).toBe(true);
    // The unit is the whole directory, removed wholesale — never a selective sweep.
    expect(seam.removeDir).toHaveBeenCalledWith(PRD_DIR);
    expect(seam.removeDir).toHaveBeenCalledTimes(1);
  });

  it("surfaces a removal failure as a failed result, never throwing", () => {
    const seam = new FakeDeleteSeam();
    seam.failRemove.add(PRD_DIR);
    const d = deps({ seam });

    const result = deletePrdAt(PRD_DIR, d);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/EACCES/);
  });
});

describe("createDelete", () => {
  // The App-facing seam: resolves a PRD id (under `root`) to a confirm preview
  // (title + Issue-file count), and on confirm runs the removal. Both entry
  // points are total — the root is filesystem-watched and can race a deletion.
  const ROOT = "/root";

  function seam(overrides: Partial<DeleteDeps> = {}) {
    return createDelete(ROOT, deps(overrides));
  }

  it("previews the PRD title and its Issue-file count", () => {
    const deleter = seam({ countIssues: () => 4 });

    const preview = deleter.readDelete("Auth System");

    expect(preview?.prdTitle).toBe("Auth System");
    expect(preview?.issueCount).toBe(4);
  });

  it("degrades a vanished PRD (thrown Issue count) to no preview", () => {
    const deleter = seam({
      countIssues: () => {
        throw new Error("PRD vanished mid-scan");
      },
    });

    expect(deleter.readDelete("gone")).toBeUndefined();
  });

  it("removes the PRD directory on confirm of a preview", () => {
    const s = new FakeDeleteSeam();
    const deleter = createDelete(ROOT, deps({ seam: s }));

    const preview = deleter.readDelete("Auth System")!;
    const result = deleter.delete(preview);

    expect(result.ok).toBe(true);
    expect(s.removeDir).toHaveBeenCalledWith("/root/Auth System");
  });

  it("degrades a removal that throws on confirm to a failed result", () => {
    const s = new FakeDeleteSeam();
    s.failRemove.add("/root/Auth System");
    const deleter = createDelete(ROOT, deps({ seam: s }));

    const preview = deleter.readDelete("Auth System")!;
    const result = deleter.delete(preview);

    expect(result.ok).toBe(false);
  });
});
