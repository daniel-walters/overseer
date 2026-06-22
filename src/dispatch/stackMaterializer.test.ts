import { describe, it, expect, vi } from "vitest";
import { materializeStack, isStacked, type StackDeps } from "./stackMaterializer.js";
import type { StackGitSeam } from "./gitSetup.js";
import type { PrSeam, PrState } from "./linkedPr.js";
import { sliceBranchName, featureBranchName } from "./gitSetup.js";

/**
 * The stack materializer is the impure shell over the pure {@link planStackCut}
 * (CONTEXT.md → Stacked output, ADR 0024): on a `done` PRD whose Issues carry ≥2
 * distinct `slice:` values, it cuts a per-slice branch from the feature branch's
 * own merge history, pushes each, and opens a chain of PRs (PR-1 → default base,
 * PR-N → slice-(N-1)'s branch) with explicit stack metadata in each body.
 *
 * Every git/`gh` edge goes through the injectable {@link StackGitSeam} +
 * {@link PrSeam}, so the whole orchestration is driven by in-memory fakes and no
 * real git/`gh` — mirroring `openPr.test.ts`'s `FakePrSeam` and
 * `gitSetup.test.ts`'s `FakeGit`. The fakes record the cuts and PR creations so a
 * test asserts the bases and body metadata, not internals.
 */

/** A scriptable {@link StackGitSeam}: records every branch cut + cherry-pick. */
class FakeStackGit implements StackGitSeam {
  /** The feature branch's Issue merges, oldest-first — set per test. */
  records: { branch: string; workCommits: string[] }[] = [];
  readonly cuts: { branch: string; startPoint: string; pick: string[] }[] = [];

  readonly stackMergeRecords = vi.fn((_repo: string, _feature: string, _base: string) =>
    this.records,
  );
  readonly createBranchAt = vi.fn(
    (_repo: string, branch: string, startPoint: string) => {
      this.cuts.push({ branch, startPoint, pick: [] });
    },
  );
  readonly cherryPick = vi.fn((_repo: string, branch: string, commits: readonly string[]) => {
    const cut = this.cuts.find((c) => c.branch === branch);
    if (cut) cut.pick.push(...commits);
  });
}

/** A {@link PrSeam} recording every push + stacked PR create. */
class FakeStackPr implements PrSeam {
  readonly created: { head: string; base: string; title: string; body: string; url: string }[] = [];
  private n = 0;

  readonly query = vi.fn((): undefined => undefined);
  readonly push = vi.fn();
  readonly create = vi.fn((): string => "https://gh/pr/single");
  readonly createWithBody = vi.fn(
    (_repo: string, head: string, base: string, title: string, body: string): string => {
      const url = `https://gh/pr/${++this.n}`;
      this.created.push({ head, base, title, body, url });
      return url;
    },
  );
}

const PRD_DIR = "/root/stacked-prs";
const FEATURE = featureBranchName("stacked-prs");

function deps(over: Partial<StackDeps> = {}): StackDeps {
  return {
    git: new FakeStackGit(),
    prSeam: new FakeStackPr(),
    defaultBase: "main",
    readSlicedIssues: () => [
      { id: "001-schema.md", slice: "1-schema", branch: "wt-a" },
      { id: "002-api.md", slice: "2-api", branch: "wt-b" },
    ],
    ...over,
  };
}

describe("materializeStack", () => {
  it("opens one PR per slice, chained bottom-up into the right bases", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    const prSeam = new FakeStackPr();
    const result = materializeStack(PRD_DIR, "/repos/api", deps({ git, prSeam }));

    expect(result.ok).toBe(true);
    expect(prSeam.created).toHaveLength(2);
    const s1Branch = sliceBranchName(FEATURE, "1-schema");
    const s2Branch = sliceBranchName(FEATURE, "2-api");
    // PR-1 targets the default base; PR-2 targets slice-1's branch.
    expect(prSeam.created[0]).toMatchObject({ head: s1Branch, base: "main" });
    expect(prSeam.created[1]).toMatchObject({ head: s2Branch, base: s1Branch });
  });

  it("cuts each slice branch at its base and replays only that slice's work", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    materializeStack(PRD_DIR, "/repos/api", deps({ git }));

    const s1Branch = sliceBranchName(FEATURE, "1-schema");
    const s2Branch = sliceBranchName(FEATURE, "2-api");
    // Slice 1 is cut from the default base and replays only its own work (cA);
    // slice 2 is cut from slice 1's branch and replays only cB.
    expect(git.cuts).toEqual([
      { branch: s1Branch, startPoint: "main", pick: ["cA"] },
      { branch: s2Branch, startPoint: s1Branch, pick: ["cB"] },
    ]);
  });

  it("reconstructs clean per-slice picks from an interleaved merge history", () => {
    // slice 1 = {001,003}, slice 2 = {002}; merged interleaved: 001, 002, 003.
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] }, // 001, slice 1
      { branch: "wt-b", workCommits: ["cB"] }, // 002, slice 2 (merged between)
      { branch: "wt-c", workCommits: ["cC"] }, // 003, slice 1 (merged last)
    ];
    materializeStack(
      PRD_DIR,
      "/repos/api",
      deps({
        git,
        readSlicedIssues: () => [
          { id: "001-schema.md", slice: "1-schema", branch: "wt-a" },
          { id: "002-api.md", slice: "2-api", branch: "wt-b" },
          { id: "003-more-schema.md", slice: "1-schema", branch: "wt-c" },
        ],
      }),
    );

    const s1 = git.cuts.find((c) => c.branch === sliceBranchName(FEATURE, "1-schema"))!;
    const s2 = git.cuts.find((c) => c.branch === sliceBranchName(FEATURE, "2-api"))!;
    // Slice 1 replays cA then cC (its own, history-ordered), never cB. Slice 2
    // replays only cB — even though it merged between slice 1's two Issues.
    expect(s1.pick).toEqual(["cA", "cC"]);
    expect(s2.pick).toEqual(["cB"]);
  });

  it("carries Part N of M + prior-PR link in each stacked PR body, bottom-up", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    const prSeam = new FakeStackPr();
    materializeStack(PRD_DIR, "/repos/api", deps({ git, prSeam }));

    // The bottom PR announces it is the base of the stack.
    expect(prSeam.created[0]!.body).toMatch(/Part 1 of 2/);
    expect(prSeam.created[0]!.body).toMatch(/base of the stack|merge this first/i);
    // The upper PR carries "Part 2 of 2", the merge-after instruction, and a link
    // to the prior (bottom) PR's url.
    expect(prSeam.created[1]!.body).toMatch(/Part 2 of 2/);
    expect(prSeam.created[1]!.body).toMatch(/merge after/i);
    expect(prSeam.created[1]!.body).toContain(prSeam.created[0]!.url);
  });

  it("returns the bottom PR's url (the stack's entry point)", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    const prSeam = new FakeStackPr();
    const result = materializeStack(PRD_DIR, "/repos/api", deps({ git, prSeam }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe(prSeam.created[0]!.url);
  });

  it("pushes every slice branch before opening any PR", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    const prSeam = new FakeStackPr();
    materializeStack(PRD_DIR, "/repos/api", deps({ git, prSeam }));

    const lastPush = Math.max(...prSeam.push.mock.invocationCallOrder);
    const firstCreate = Math.min(...prSeam.createWithBody.mock.invocationCallOrder);
    expect(lastPush).toBeLessThan(firstCreate);
  });

  it("surfaces a failed cherry-pick as a failed result, never throwing", () => {
    const git = new FakeStackGit();
    git.records = [
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ];
    git.cherryPick.mockImplementation(() => {
      throw new Error("cherry-pick conflict");
    });
    const result = materializeStack(PRD_DIR, "/repos/api", deps({ git }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cherry-pick|conflict/i);
  });

  it("refuses when fewer than 2 slice branches resolve from history", () => {
    // Only slice 1's branch is found in the merge history — no real stack to cut.
    const git = new FakeStackGit();
    git.records = [{ branch: "wt-a", workCommits: ["cA"] }];
    const result = materializeStack(PRD_DIR, "/repos/api", deps({ git }));

    expect(result.ok).toBe(false);
  });
});

describe("isStacked", () => {
  it("is true for ≥2 distinct slice values", () => {
    expect(
      isStacked([
        { id: "1.md", slice: "1-schema", branch: "a" },
        { id: "2.md", slice: "2-api", branch: "b" },
      ]),
    ).toBe(true);
  });

  it("is false for a single distinct slice (today's single-PR path)", () => {
    expect(
      isStacked([
        { id: "1.md", slice: "1-only", branch: "a" },
        { id: "2.md", slice: "1-only", branch: "b" },
      ]),
    ).toBe(false);
  });

  it("is false when no Issue carries a slice", () => {
    expect(
      isStacked([
        { id: "1.md", slice: "", branch: "a" },
        { id: "2.md", slice: "", branch: "b" },
      ]),
    ).toBe(false);
  });
});
