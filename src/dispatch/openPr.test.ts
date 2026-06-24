import { describe, it, expect, vi } from "vitest";
import { openPrFor, createOpenPr, type OpenPrDeps } from "./openPr.js";
import type { GitSeam } from "./gitSetup.js";
import { featureBranchName } from "./gitSetup.js";
import type { PrSeam, PrState } from "./linkedPr.js";
import type { StackGitSeam, MergeRecord } from "./gitSetup.js";
import type { SlicedIssue } from "./stackMaterializer.js";
import { sliceBranchName } from "./gitSetup.js";

/**
 * Open PR is the board's first outward GitHub write: on a `done` PRD it pushes
 * the PRD's derived feature branch and opens a PR from it into the repo's
 * resolved default base (CONTEXT.md, the parent PRD). The orchestration is the
 * deep module — it resolves the single repo, refuses a multi-repo PRD and a
 * branch that already has a PR, resolves the base, then pushes and creates — all
 * behind the injectable {@link PrSeam} + {@link GitSeam}, so every branch is
 * unit-tested with in-memory fakes and no real `git`/`gh` (prior art:
 * `gitSetup.test.ts`'s `FakeGit`, `linkedPr.test.ts`'s `FakePrSeam`).
 *
 * A scriptable stand-in for the real `gh`/`git` PR seam, mirroring the linked-PR
 * test's `FakePrSeam` but extended with the two write methods this slice adds:
 * it answers a query from in-memory state, records every push/create, and can be
 * scripted to make either write throw (a `gh`/`git` failure).
 */
class FakePrSeam implements PrSeam {
  /** `repo\nbranch` → the PR the fake reports for that branch (existing-PR guard). */
  private readonly prs = new Map<string, { state: PrState; url: string }>();
  /** Repos whose `push` should throw, simulating a `git push` failure. */
  readonly failPush = new Set<string>();
  /** Repos whose `create` should throw, simulating a `gh pr create` failure. */
  readonly failCreate = new Set<string>();

  readonly query = vi.fn((repo: string, branch: string) =>
    this.prs.get(`${repo}\n${branch}`),
  );
  readonly push = vi.fn((repo: string, _branch: string) => {
    if (this.failPush.has(repo)) throw new Error(`git push failed in ${repo}`);
  });
  readonly create = vi.fn((repo: string, _branch: string, _base: string): string => {
    if (this.failCreate.has(repo)) throw new Error(`gh pr create failed in ${repo}`);
    return "https://gh/pr/new";
  });
  readonly createWithBody = vi.fn(
    (_repo: string, head: string, _base: string, _title: string, _body: string): string =>
      `https://gh/pr/${head}`,
  );

  /** Register a pre-existing PR so the orchestration's existing-PR guard fires. */
  setPr(repo: string, branch: string, state: PrState, url: string): void {
    this.prs.set(`${repo}\n${branch}`, { state, url });
  }
}

/** A GitSeam stub answering only the one method Open PR uses: defaultBase. */
function fakeGit(base = "origin/main"): GitSeam {
  return {
    isGitRepo: vi.fn(() => true),
    defaultBase: vi.fn(() => base),
    branchExists: vi.fn(() => true),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
  };
}

const PRD_DIR = "/root/Auth System";
const BRANCH = featureBranchName("Auth System");

/**
 * A {@link StackGitSeam} stub for the single-PR tests (no stack), recording cuts
 * so a test can assert the stack path was *not* taken. Stack-specific behaviour is
 * exercised in `stackMaterializer.test.ts`; here it just needs to exist.
 */
function fakeStackGit(records: MergeRecord[] = []): StackGitSeam {
  return {
    stackMergeRecords: vi.fn(() => records),
    createBranchAt: vi.fn(),
    cherryPick: vi.fn(),
    checkoutBranch: vi.fn(),
  };
}

function deps(overrides: Partial<OpenPrDeps> = {}): OpenPrDeps {
  return {
    prSeam: new FakePrSeam(),
    git: fakeGit(),
    readRepos: () => ["/repos/api"],
    stackGit: fakeStackGit(),
    // Default: a single-slice PRD — the single-PR path, exactly as today.
    readSlicedIssues: (): readonly SlicedIssue[] => [],
    ...overrides,
  };
}

describe("openPrFor", () => {
  it("pushes the feature branch then creates a PR into the resolved default base", () => {
    const prSeam = new FakePrSeam();
    const git = fakeGit("origin/master");
    const d = deps({ prSeam, git, readRepos: () => ["/repos/api"] });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(true);
    // Pushed the derived feature branch to its repo.
    expect(prSeam.push).toHaveBeenCalledWith("/repos/api", BRANCH);
    // Created the PR into the repo's *resolved* default base, not a hardcoded main.
    // `defaultBase` resolves the remote-tracking ref `origin/master`; the PR base
    // is the bare branch name `gh pr create --base` wants — not `origin/master`.
    expect(prSeam.create).toHaveBeenCalledWith("/repos/api", BRANCH, "master");
  });

  it("strips the origin/ prefix off the resolved base for gh pr create", () => {
    // `defaultBase` returns a remote-tracking ref (`origin/main`); `gh pr create
    // --base` wants the bare branch name (`main`) — `origin/main` is rejected.
    const prSeam = new FakePrSeam();
    const d = deps({ prSeam, git: fakeGit("origin/main") });

    openPrFor(PRD_DIR, d);

    expect(prSeam.create).toHaveBeenCalledWith("/repos/api", BRANCH, "main");
  });

  it("pushes before it creates (a missing remote branch can't fail the create)", () => {
    const prSeam = new FakePrSeam();
    const d = deps({ prSeam });

    openPrFor(PRD_DIR, d);

    const pushOrder = prSeam.push.mock.invocationCallOrder[0]!;
    const createOrder = prSeam.create.mock.invocationCallOrder[0]!;
    expect(pushOrder).toBeLessThan(createOrder);
  });

  it("refuses when a PR already exists for the branch, opening no duplicate", () => {
    const prSeam = new FakePrSeam();
    prSeam.setPr("/repos/api", BRANCH, "OPEN", "https://gh/pr/1");
    const d = deps({ prSeam });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    expect(prSeam.push).not.toHaveBeenCalled();
    expect(prSeam.create).not.toHaveBeenCalled();
  });

  it("refuses a merged PR too (no duplicate for a branch that already landed)", () => {
    const prSeam = new FakePrSeam();
    prSeam.setPr("/repos/api", BRANCH, "MERGED", "https://gh/pr/1");
    const d = deps({ prSeam });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    expect(prSeam.create).not.toHaveBeenCalled();
  });

  it("refuses a PRD whose Issues span more than one repo (single-repo guard)", () => {
    const prSeam = new FakePrSeam();
    const d = deps({ prSeam, readRepos: () => ["/repos/api", "/repos/web"] });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/repo/i);
    // Neither write fires, and we never even query for an existing PR.
    expect(prSeam.query).not.toHaveBeenCalled();
    expect(prSeam.push).not.toHaveBeenCalled();
    expect(prSeam.create).not.toHaveBeenCalled();
  });

  it("refuses a PRD that names no repo", () => {
    const prSeam = new FakePrSeam();
    const d = deps({ prSeam, readRepos: () => [] });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    expect(prSeam.push).not.toHaveBeenCalled();
  });

  it("surfaces a push failure as a failed result, creating no PR", () => {
    const prSeam = new FakePrSeam();
    prSeam.failPush.add("/repos/api");
    const d = deps({ prSeam });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/push/i);
    // The push failed before the create, so no PR was opened.
    expect(prSeam.create).not.toHaveBeenCalled();
  });

  it("surfaces a PR-create failure as a failed result", () => {
    const prSeam = new FakePrSeam();
    prSeam.failCreate.add("/repos/api");
    const d = deps({ prSeam });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/create|gh/i);
  });

  it("returns the created PR url on success", () => {
    const d = deps();

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://gh/pr/new");
  });

  it("opens exactly one PR when no Issue carries a slice (today's behaviour)", () => {
    const prSeam = new FakePrSeam();
    const d = deps({ prSeam, readSlicedIssues: () => [] });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(true);
    // The single-PR seam was used; the stacked-PR create was never touched.
    expect(prSeam.create).toHaveBeenCalledTimes(1);
    expect(prSeam.createWithBody).not.toHaveBeenCalled();
  });

  it("opens exactly one PR when every Issue shares a single slice", () => {
    const prSeam = new FakePrSeam();
    const d = deps({
      prSeam,
      readSlicedIssues: () => [
        { id: "001.md", slice: "1-only", branch: "wt-a" },
        { id: "002.md", slice: "1-only", branch: "wt-b" },
      ],
    });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(true);
    expect(prSeam.create).toHaveBeenCalledTimes(1);
    expect(prSeam.createWithBody).not.toHaveBeenCalled();
  });

  it("materializes a stack when ≥2 distinct slices are present", () => {
    const prSeam = new FakePrSeam();
    const stackGit = fakeStackGit([
      { branch: "wt-a", workCommits: ["cA"] },
      { branch: "wt-b", workCommits: ["cB"] },
    ]);
    const d = deps({
      prSeam,
      stackGit,
      readSlicedIssues: () => [
        { id: "001.md", slice: "1-schema", branch: "wt-a" },
        { id: "002.md", slice: "2-api", branch: "wt-b" },
      ],
    });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(true);
    // The stacked path: two chained PRs via createWithBody, never the single create.
    expect(prSeam.create).not.toHaveBeenCalled();
    expect(prSeam.createWithBody).toHaveBeenCalledTimes(2);
    const s1 = sliceBranchName(BRANCH, "1-schema");
    expect(prSeam.createWithBody).toHaveBeenCalledWith(
      "/repos/api",
      s1,
      "main",
      expect.any(String),
      expect.stringMatching(/Part 1 of 2/),
    );
    // The result url is the bottom (entry-point) PR.
    if (result.ok) expect(result.url).toBe(`https://gh/pr/${s1}`);
  });

  it("refuses to re-open a stack when the bottom slice branch already has a PR", () => {
    // For a stacked PRD the duplicate-PR guard checks the bottom slice branch (where
    // materializeStack opens the entry-point PR), not the feature branch (which never
    // has a PR after a stack materialization).
    const prSeam = new FakePrSeam();
    const s1 = sliceBranchName(BRANCH, "1-schema");
    prSeam.setPr("/repos/api", s1, "OPEN", "https://gh/pr/1");
    const d = deps({
      prSeam,
      readSlicedIssues: () => [
        { id: "001.md", slice: "1-schema", branch: "wt-a" },
        { id: "002.md", slice: "2-api", branch: "wt-b" },
      ],
    });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    expect(prSeam.createWithBody).not.toHaveBeenCalled();
  });

  it("degrades a thrown repo read to a failed result, never crashing", () => {
    const prSeam = new FakePrSeam();
    const d = deps({
      prSeam,
      readRepos: () => {
        throw new Error("PRD vanished mid-scan");
      },
    });

    const result = openPrFor(PRD_DIR, d);

    expect(result.ok).toBe(false);
    expect(prSeam.push).not.toHaveBeenCalled();
  });
});

describe("createOpenPr", () => {
  // The App-facing seam: resolves a PRD id (under `root`) to a confirm preview
  // (branch + resolved base + eligibility), and on confirm runs the orchestration.
  // The preview's eligibility carries the same single-repo / existing-PR guards the
  // action enforces, so the modal shows the refusal before the user can confirm.
  const ROOT = "/root";

  function seam(overrides: Partial<OpenPrDeps> = {}) {
    return createOpenPr(ROOT, deps(overrides));
  }

  it("previews the derived feature branch and the resolved default base", () => {
    const opener = seam({ git: fakeGit("origin/master") });

    const preview = opener.readOpenPr("Auth System");

    expect(preview?.branch).toBe(BRANCH);
    // The preview shows the bare base branch the PR opens into, not the
    // `origin/`-prefixed remote-tracking ref `defaultBase` resolves.
    expect(preview?.base).toBe("master");
    expect(preview?.eligibility.canOpen).toBe(true);
  });

  it("previews a refusal for a multi-repo PRD (single-repo guard, visible reason)", () => {
    const opener = seam({ readRepos: () => ["/repos/api", "/repos/web"] });

    const preview = opener.readOpenPr("Auth System");

    expect(preview?.eligibility.canOpen).toBe(false);
    if (preview && !preview.eligibility.canOpen) {
      expect(preview.eligibility.reason).toMatch(/repo/i);
    }
  });

  it("previews a refusal when a PR already exists for the branch", () => {
    const prSeam = new FakePrSeam();
    prSeam.setPr("/repos/api", BRANCH, "OPEN", "https://gh/pr/1");
    const opener = seam({ prSeam });

    const preview = opener.readOpenPr("Auth System");

    expect(preview?.eligibility.canOpen).toBe(false);
    if (preview && !preview.eligibility.canOpen) {
      expect(preview.eligibility.reason).toMatch(/exists|duplicate/i);
    }
  });

  it("degrades a vanished PRD (thrown repo read) to no preview", () => {
    const opener = seam({
      readRepos: () => {
        throw new Error("PRD vanished mid-scan");
      },
    });

    expect(opener.readOpenPr("gone")).toBeUndefined();
  });

  it("pushes and creates on confirm of an eligible preview", () => {
    const prSeam = new FakePrSeam();
    const opener = createOpenPr(ROOT, deps({ prSeam }));

    const preview = opener.readOpenPr("Auth System")!;
    const result = opener.openPr(preview);

    expect(result.ok).toBe(true);
    expect(prSeam.push).toHaveBeenCalledWith("/repos/api", BRANCH);
    expect(prSeam.create).toHaveBeenCalledWith("/repos/api", BRANCH, "main");
  });
});
