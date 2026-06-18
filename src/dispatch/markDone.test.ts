import { describe, it, expect, vi } from "vitest";
import { createMarkDone, type MarkDoneDeps } from "./markDone.js";

/**
 * Mark done is the board's first human-triggered status flip with no spawn behind
 * it (CONTEXT.md → mark done): `m` on a `ready-for-human` Issue advances it
 * straight to `done`, behind a confirm preview. The orchestration is a thin deep
 * module — thinner than its review/delete twins because there is no external state
 * (git/gh) to resolve: it resolves the selected Issue into a preview (its title +
 * file path) and, on confirm, writes `status: done` through the injectable
 * {@link MarkDoneDeps.writeStatus} edge (reusing the existing `writeStatus`
 * primitive). Every branch is unit-tested with an in-memory fake and no real file
 * write (prior art: `deletePrd.test.ts`'s `FakeDeleteSeam`).
 */

const ROOT = "/root";

function deps(overrides: Partial<MarkDoneDeps> = {}): MarkDoneDeps {
  return {
    readIssue: () => ({ id: "001-x.md", title: "Provision a secret", path: "/root/p/001-x.md" }),
    writeStatus: vi.fn(),
    ...overrides,
  };
}

describe("createMarkDone", () => {
  it("resolves the selected Issue into a preview naming its title and the transition", () => {
    const m = createMarkDone(ROOT, deps());
    const preview = m.readMarkDone("p", "001-x.md");
    expect(preview).toBeDefined();
    expect(preview?.issueTitle).toBe("Provision a secret");
    expect(preview?.issuePath).toBe("/root/p/001-x.md");
  });

  it("reads the Issue from the PRD directory under the root", () => {
    const readIssue = vi.fn(() => ({
      id: "001-x.md",
      title: "T",
      path: "/root/p/001-x.md",
    }));
    const m = createMarkDone(ROOT, deps({ readIssue }));
    m.readMarkDone("p", "001-x.md");
    expect(readIssue).toHaveBeenCalledWith("/root/p", "001-x.md");
  });

  it("yields undefined when the Issue vanished from the watched root (a raced deletion)", () => {
    const readIssue = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const m = createMarkDone(ROOT, deps({ readIssue }));
    expect(m.readMarkDone("p", "gone.md")).toBeUndefined();
  });

  it("writes status done to the previewed Issue's path on confirm", () => {
    const writeStatus = vi.fn();
    const m = createMarkDone(ROOT, deps({ writeStatus }));
    m.markDone({ issueTitle: "T", issuePath: "/root/p/001-x.md" });
    expect(writeStatus).toHaveBeenCalledTimes(1);
    expect(writeStatus).toHaveBeenCalledWith("/root/p/001-x.md", "done");
  });
});
