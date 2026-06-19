import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration test for the bundled `commit-docs.sh` — one level more real than
 * `gitSetup.test.ts`, which drives the in-memory {@link GitSeam} fake. Bash
 * cannot take that seam, so each case here builds a temp git repo with a real
 * `origin` (so base resolution resolves), seeds working-tree state, runs the
 * actual script via `bash`, and asserts on the resulting branch and commit.
 */

/** The shipped script, resolved from this test file (two levels up from `src/dispatch`). */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "overseer-to-prd",
  "scripts",
  "commit-docs.sh",
);

const BRANCH = "auth-system";

/** Run a `git -C <repo>` command, returning trimmed stdout. */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

/** Run `commit-docs.sh <repo> <branch>`, capturing exit status and output. */
function run(
  repo: string,
  branch: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT, repo, branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

let scratch: string;

/**
 * Build a temp work repo with an `origin` so base resolution has a real remote.
 * `originDefault` becomes `origin/HEAD`'s target (so the fallback path is taken
 * when it is `undefined`); the work repo is left checked out on a local `main`
 * with whatever doc/non-doc working-tree state the case seeds afterwards.
 */
function initRepo(
  opts: { originDefault?: string; extraOriginBranch?: { name: string; file: string } } = {},
): string {
  const root = mkdtempSync(join(scratch, "repo-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(work);

  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  git(work, "init", "-b", "main");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test User");
  git(work, "remote", "add", "origin", origin);

  writeFileSync(join(work, "README.md"), "init\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "main");

  // Optionally seed a second origin branch the feature branch can be rooted on,
  // to prove base resolution actually reads origin/HEAD (not just origin/main).
  if (opts.extraOriginBranch) {
    const { name, file } = opts.extraOriginBranch;
    git(work, "checkout", "-b", name);
    writeFileSync(join(work, file), "from-origin-default\n");
    git(work, "add", file);
    git(work, "commit", "-m", `${name}-only`);
    git(work, "push", "origin", name);
    git(work, "checkout", "main");
  }

  git(work, "fetch", "origin");

  if (opts.originDefault) {
    git(work, "remote", "set-head", "origin", opts.originDefault);
  } else {
    // Guarantee the fallback path: some git versions set origin/HEAD on fetch.
    try {
      git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    } catch {
      // origin/HEAD wasn't set — already on the fallback path.
    }
  }
  return work;
}

/** Whether a local branch exists in `repo`. */
function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/** The files changed by the tip commit on `branch` (its diff against its parent). */
function committedFiles(repo: string, branch: string): string[] {
  const out = git(
    repo,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    branch,
  );
  return out ? out.split("\n") : [];
}

/** The subject line of the tip commit on `branch`. */
function commitSubject(repo: string, branch: string): string {
  return git(repo, "log", "-1", "--format=%s", branch);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "commit-docs-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("commit-docs.sh", () => {
  it("is a clean no-op when the target is not a git repo", () => {
    const notARepo = mkdtempSync(join(scratch, "plain-"));

    const result = run(notARepo, BRANCH);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not a git repo/i);
    // No branch could be created in a non-repo.
    expect(branchExists(notARepo, BRANCH)).toBe(false);
  });

  it("is a no-op on a clean tree — no branch created, nothing committed", () => {
    const repo = initRepo();

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(branchExists(repo, BRANCH)).toBe(false);
  });

  it("is a no-op when only non-doc files changed", () => {
    const repo = initRepo();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(branchExists(repo, BRANCH)).toBe(false);
  });

  it("creates the branch from the resolved base and commits the docs when absent", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0001-x.md"), "# ADR 1\n");

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(branchExists(repo, BRANCH)).toBe(true);
    // The script checks the branch out so it is HEAD.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(committedFiles(repo, BRANCH).sort()).toEqual([
      "CONTEXT.md",
      "docs/adr/0001-x.md",
    ]);
  });

  it("roots the new branch on origin/HEAD when it is set (not origin/main)", () => {
    // origin/HEAD points at `develop`, which carries a commit `main` lacks.
    const repo = initRepo({
      originDefault: "develop",
      extraOriginBranch: { name: "develop", file: "DEVELOP_MARKER" },
    });
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    // The feature branch was created from origin/develop, so develop's marker
    // commit is in its history — proving origin/HEAD resolution, not origin/main.
    const log = git(repo, "log", "--format=%s", BRANCH);
    expect(log).toMatch(/develop-only/);
  });

  it("reuses an existing branch and commits onto it (idempotent)", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary v1\n");

    const first = run(repo, BRANCH);
    expect(first.status).toBe(0);
    const firstCommit = git(repo, "rev-parse", BRANCH);

    // A second session edits the docs again and re-runs.
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary v2\n");
    const second = run(repo, BRANCH);

    expect(second.status).toBe(0);
    // The branch was reused, not recreated: the first commit is still an
    // ancestor, and a new commit sits on top of it.
    expect(git(repo, "rev-parse", `${BRANCH}~1`)).toBe(firstCommit);
    expect(commitSubject(repo, BRANCH)).toBe(`docs: CONTEXT for ${BRANCH}`);
  });

  it("commits only the doc paths, leaving unrelated modified work untouched", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");
    // An unrelated dirty file the user has in flight.
    writeFileSync(join(repo, "scratch.txt"), "work in progress\n");

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(committedFiles(repo, BRANCH)).toEqual(["CONTEXT.md"]);
    // The unrelated file is still present and untracked — out of the commit.
    expect(git(repo, "status", "--porcelain", "scratch.txt")).toMatch(
      /^\?\? scratch\.txt$/,
    );
  });

  it("keeps unrelated already-staged work out of the docs commit", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");
    // The user has pre-staged unrelated work in the index.
    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    git(repo, "add", "feature.ts");

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(committedFiles(repo, BRANCH)).toEqual(["CONTEXT.md"]);
    // It remains staged (untouched), not swept into the docs commit.
    expect(git(repo, "status", "--porcelain", "feature.ts")).toMatch(
      /^A  feature\.ts$/,
    );
  });

  it("writes a CONTEXT-only message when only CONTEXT files changed", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");

    expect(run(repo, BRANCH).status).toBe(0);
    expect(commitSubject(repo, BRANCH)).toBe(`docs: CONTEXT for ${BRANCH}`);
  });

  it("writes an ADRs-only message when only ADR files changed", () => {
    const repo = initRepo();
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0001-x.md"), "# ADR 1\n");

    expect(run(repo, BRANCH).status).toBe(0);
    expect(commitSubject(repo, BRANCH)).toBe(`docs: ADRs for ${BRANCH}`);
  });

  it("writes a combined message when both CONTEXT and ADR files changed", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0001-x.md"), "# ADR 1\n");

    expect(run(repo, BRANCH).status).toBe(0);
    expect(commitSubject(repo, BRANCH)).toBe(`docs: CONTEXT + ADRs for ${BRANCH}`);
  });

  it("includes per-context nested docs when a CONTEXT-MAP.md is present", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT-MAP.md"), "# Map\n");
    mkdirSync(join(repo, "services", "api", "docs", "adr"), { recursive: true });
    writeFileSync(
      join(repo, "services", "api", "CONTEXT.md"),
      "# API glossary\n",
    );
    writeFileSync(
      join(repo, "services", "api", "docs", "adr", "0001-api.md"),
      "# API ADR\n",
    );

    const result = run(repo, BRANCH);

    expect(result.status).toBe(0);
    expect(committedFiles(repo, BRANCH).sort()).toEqual([
      "CONTEXT-MAP.md",
      "services/api/CONTEXT.md",
      "services/api/docs/adr/0001-api.md",
    ]);
    expect(commitSubject(repo, BRANCH)).toBe(`docs: CONTEXT + ADRs for ${BRANCH}`);
  });

  it("exits non-zero with a message when a git operation fails", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# Glossary\n");

    // `bad..name` is an invalid git ref, so branch creation fails for real.
    const result = run(repo, "bad..name");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/fail/i);
    expect(branchExists(repo, "bad..name")).toBe(false);
  });
});
