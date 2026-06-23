import { describe, it, expect, vi } from "vitest";
import {
  deriveLinkedPr,
  createLinkedPrLookup,
  parsePrList,
  type PrSeam,
  type PrState,
} from "./linkedPr.js";
import { featureBranchName } from "./gitSetup.js";

/**
 * The Linked PR overlay is the highest-value surface of this slice: it joins a
 * `done` PRD's derived feature branch against a live `gh` query for a PR on that
 * branch, and produces a three-state overlay — *no PR* / *open* / *merged* (ADR
 * 0013, CONTEXT.md). The derivation is pure data-in/data-out behind one seam (the
 * `PrSeam` query), fed an in-memory fake — no test shells out to real `git`/`gh`,
 * mirroring how Liveness is tested behind its registry-query seam and the GitSeam
 * orchestration is tested behind its fake.
 *
 * A scriptable stand-in for the real `gh` query seam, mirroring the GitSeam
 * test's `FakeGit`: answers a PR query from in-memory state keyed by
 * `repo\nbranch`, and records every call so gating/bounding can be asserted.
 */
class FakePrSeam implements PrSeam {
  /** `repo\nbranch` → the PR the fake reports for that branch. */
  private readonly prs = new Map<string, { state: PrState; url: string }>();

  readonly query = vi.fn((repo: string, branch: string) => {
    return this.prs.get(`${repo}\n${branch}`);
  });
  // The write half of the seam: unused by the read-path derivation tests here
  // (exercised in openPr.test.ts), present only so the fake satisfies the seam.
  readonly push = vi.fn();
  readonly create = vi.fn(() => "https://gh/pr/new");
  readonly createWithBody = vi.fn(() => "https://gh/pr/stacked");

  /** Register a PR the fake should report for `repo` + `branch`. */
  setPr(repo: string, branch: string, state: PrState, url: string): void {
    this.prs.set(`${repo}\n${branch}`, { state, url });
  }
}

describe("deriveLinkedPr", () => {
  it("reports an open overlay when the query finds an OPEN PR for the branch", () => {
    const seam = new FakePrSeam();
    seam.setPr("/repo", "my-feature", "OPEN", "https://gh/pr/1");

    expect(deriveLinkedPr(seam, "/repo", "my-feature")).toEqual({
      state: "open",
      url: "https://gh/pr/1",
    });
  });

  it("reports a merged overlay when the query finds a MERGED PR — the end-of-lifecycle signal", () => {
    // The merged state is the one a stored link could never keep honest (ADR
    // 0013): it is the real "the out-of-scope default-branch merge happened"
    // signal, so the live query must surface it distinctly from open.
    const seam = new FakePrSeam();
    seam.setPr("/repo", "my-feature", "MERGED", "https://gh/pr/2");

    expect(deriveLinkedPr(seam, "/repo", "my-feature")).toEqual({
      state: "merged",
      url: "https://gh/pr/2",
    });
  });

  it("reports no overlay when the query finds no PR for the branch", () => {
    // No PR ⇒ no marker (the three-state's third state is the overlay's absence).
    // A `gh` failure degrades to this same `undefined` (asserted via the lookup
    // below), so the marker is never an error state — it simply does not appear.
    const seam = new FakePrSeam();

    expect(deriveLinkedPr(seam, "/repo", "no-such-branch")).toBeUndefined();
  });

  it("queries the seam with the given repo and branch verbatim", () => {
    // The query key is the PRD's repo + its *derived* feature branch; the
    // derivation must pass them through untouched so the seam can answer for the
    // exact branch the Open-PR write path would push.
    const seam = new FakePrSeam();
    deriveLinkedPr(seam, "/some/repo", "the-branch");

    expect(seam.query).toHaveBeenCalledWith("/some/repo", "the-branch");
  });
});

describe("createLinkedPrLookup", () => {
  it("derives the feature branch from the PRD dir and queries the resolved repo", () => {
    // The branch identity is purely derived from the PRD directory name (reusing
    // `featureBranchName`), so the lookup needs no stored link — exactly ADR
    // 0013's property. It resolves the PRD's single repo and queries that branch.
    const seam = new FakePrSeam();
    const branch = featureBranchName("Auth System");
    seam.setPr("/repos/api", branch, "OPEN", "https://gh/pr/9");

    const lookup = createLinkedPrLookup({
      seam,
      readRepos: () => ["/repos/api"],
    });

    expect(lookup("/root/Auth System")).toEqual({
      state: "open",
      url: "https://gh/pr/9",
    });
    expect(seam.query).toHaveBeenCalledWith("/repos/api", branch);
  });

  it("returns no overlay when the PRD spans multiple repos (no single feature-branch PR)", () => {
    // A multi-repo PRD's feature branch is per-repo, so there is no single PR to
    // surface in v1 (the write path refuses it outright). The read overlay
    // degrades safely to no marker rather than guessing a repo to query.
    const seam = new FakePrSeam();
    const lookup = createLinkedPrLookup({
      seam,
      readRepos: () => ["/repos/api", "/repos/web"],
    });

    expect(lookup("/root/multi")).toBeUndefined();
    expect(seam.query).not.toHaveBeenCalled();
  });

  it("returns no overlay when the PRD names no repo", () => {
    // No repo ⇒ nothing to query; degrade to no marker without shelling out.
    const seam = new FakePrSeam();
    const lookup = createLinkedPrLookup({ seam, readRepos: () => [] });

    expect(lookup("/root/repoless")).toBeUndefined();
    expect(seam.query).not.toHaveBeenCalled();
  });

  it("degrades a thrown query to no overlay, never crashing the scan", () => {
    // A `gh` failure (missing/unauthed/non-GitHub/network) must resolve to *no
    // PR*, not an error state, hang, or crash (ADR 0013). Even if the seam throws
    // rather than returning undefined, the lookup swallows it to no marker.
    const seam: PrSeam = {
      query: () => {
        throw new Error("gh: command not found");
      },
      push: () => {},
      create: () => "",
      createWithBody: () => "",
    };
    const lookup = createLinkedPrLookup({
      seam,
      readRepos: () => ["/repos/api"],
    });

    expect(lookup("/root/Auth System")).toBeUndefined();
  });

  it("degrades a thrown repo read to no overlay", () => {
    // Resolving the PRD's repo reads the Issue files, which the watched root can
    // delete mid-scan. A throw there degrades to no marker, never out of the scan.
    const seam = new FakePrSeam();
    const lookup = createLinkedPrLookup({
      seam,
      readRepos: () => {
        throw new Error("PRD vanished mid-scan");
      },
    });

    expect(lookup("/root/gone")).toBeUndefined();
  });
});

describe("parsePrList", () => {
  // The pure parse half of the real `gh` seam — the testable logic behind the
  // un-fakeable shell-out. It folds `gh pr list --json state,url` rows to the one
  // PR the overlay surfaces, with OPEN winning over MERGED and CLOSED → no PR.
  it("reports an OPEN PR from the query rows", () => {
    expect(
      parsePrList(JSON.stringify([{ state: "OPEN", url: "https://gh/1" }])),
    ).toEqual({ state: "OPEN", url: "https://gh/1" });
  });

  it("reports a MERGED PR from the query rows — the end-of-lifecycle signal", () => {
    expect(
      parsePrList(JSON.stringify([{ state: "MERGED", url: "https://gh/2" }])),
    ).toEqual({ state: "MERGED", url: "https://gh/2" });
  });

  it("folds a CLOSED-unmerged PR into no PR (the marker disappears)", () => {
    // Only no-PR / open / merged are distinguished; a closed-unmerged PR reads as
    // no open PR — the marker disappears (CONTEXT.md out-of-scope, ADR 0013).
    expect(
      parsePrList(JSON.stringify([{ state: "CLOSED", url: "https://gh/3" }])),
    ).toBeUndefined();
  });

  it("reports no PR for an empty result", () => {
    expect(parsePrList("[]")).toBeUndefined();
  });

  it("prefers an OPEN PR over a MERGED one when both are present", () => {
    // The live, awaiting-merge PR is the one to surface and act on; an older
    // merged PR for the same branch must not mask it.
    const json = JSON.stringify([
      { state: "MERGED", url: "https://gh/old" },
      { state: "OPEN", url: "https://gh/new" },
    ]);

    expect(parsePrList(json)).toEqual({ state: "OPEN", url: "https://gh/new" });
  });

  it("reports no PR on unparseable or non-array output, never throwing", () => {
    // A `gh` hiccup that printed garbage or an error object must degrade to no
    // marker, not crash the scan.
    expect(parsePrList("not json")).toBeUndefined();
    expect(parsePrList("")).toBeUndefined();
    expect(parsePrList('{"error":"boom"}')).toBeUndefined();
  });

  it("skips rows missing a usable state or url", () => {
    const json = JSON.stringify([
      { state: "OPEN" },
      { url: "https://gh/no-state" },
      { state: "MERGED", url: "https://gh/ok" },
    ]);

    expect(parsePrList(json)).toEqual({ state: "MERGED", url: "https://gh/ok" });
  });
});
