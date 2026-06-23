import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realStackGitSeam } from "./gitSetup.js";

/**
 * Integration test for {@link realStackGitSeam} against **real git** — the one
 * place the cut-from-history mechanic is validated against actual git plumbing,
 * as the Issue requires ("the exact git invocations… are to be validated against
 * real git during implementation"). The pure {@link planStackCut} and the
 * materializer are unit-tested with fakes; this proves the production seam reads
 * the feature branch's merge history correctly and that replaying each slice's
 * own work onto the prior slice reconstructs a **clean per-slice diff**, even for
 * an interleaved/parallel merge history — the case a naive "truncate the feature
 * branch at slice N's last merge" gets wrong.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Merge one Issue's work branch into `feature` with the default `--no-ff` message. */
function mergeIssue(repo: string, branch: string, file: string): void {
  git(repo, "checkout", "feature");
  git(repo, "checkout", "-b", branch);
  writeFileSync(join(repo, file), `${branch} content\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `work ${branch}`);
  git(repo, "checkout", "feature");
  git(repo, "merge", "--no-ff", branch);
  git(repo, "branch", "-D", branch); // the reactor deletes the work branch post-merge
}

describe("realStackGitSeam against real git", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "stack-git-"));
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    git(repo, "checkout", "-b", "feature");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reads each Issue merge's branch + work commits from the feature history", () => {
    mergeIssue(repo, "wt-aaa", "fileA");
    mergeIssue(repo, "wt-bbb", "fileB");

    const records = realStackGitSeam.stackMergeRecords(repo, "feature", "main");

    // Oldest-first, branch recovered from the default merge message, one work
    // commit each.
    expect(records.map((r) => r.branch)).toEqual(["wt-aaa", "wt-bbb"]);
    expect(records.every((r) => r.workCommits.length === 1)).toBe(true);
  });

  it("cuts clean per-slice branches from an interleaved merge history", () => {
    // Merge order A, C, B, D. Slice 1 = {A,B}, slice 2 = {C}, slice 3 = {D}: so
    // slice 1's second Issue (B) merges AFTER slice 2's only Issue (C). A naive
    // truncate-at-last-merge would leak fileC into slice 1.
    mergeIssue(repo, "wt-a", "fileA"); // slice 1
    mergeIssue(repo, "wt-c", "fileC"); // slice 2 (merged between slice 1's two)
    mergeIssue(repo, "wt-b", "fileB"); // slice 1
    mergeIssue(repo, "wt-d", "fileD"); // slice 3

    const records = realStackGitSeam.stackMergeRecords(repo, "feature", "main");
    const work = (branch: string) =>
      records.find((r) => r.branch === branch)!.workCommits;

    // slice 1 = A then B (history order); slice 2 = C; slice 3 = D.
    const slice1 = "feature-slice-1-schema";
    const slice2 = "feature-slice-2-api";
    const slice3 = "feature-slice-3-ui";

    realStackGitSeam.createBranchAt(repo, slice1, "main");
    realStackGitSeam.cherryPick(repo, slice1, [...work("wt-a"), ...work("wt-b")]);

    realStackGitSeam.createBranchAt(repo, slice2, slice1);
    realStackGitSeam.cherryPick(repo, slice2, work("wt-c"));

    realStackGitSeam.createBranchAt(repo, slice3, slice2);
    realStackGitSeam.cherryPick(repo, slice3, work("wt-d"));

    // Slice 1's branch holds only its own files — never fileC, the leak a naive
    // truncation would cause.
    const slice1Files = git(repo, "ls-tree", "--name-only", slice1).split("\n");
    expect(slice1Files).toContain("fileA");
    expect(slice1Files).toContain("fileB");
    expect(slice1Files).not.toContain("fileC");
    expect(slice1Files).not.toContain("fileD");

    // Each upper slice's diff vs its base is exactly its own slice's files.
    expect(git(repo, "diff", "--name-only", slice1, slice2)).toBe("fileC");
    expect(git(repo, "diff", "--name-only", slice2, slice3)).toBe("fileD");

    // The top slice reconstructs the whole feature tree — no work lost.
    expect(git(repo, "rev-parse", `${slice3}^{tree}`)).toBe(
      git(repo, "rev-parse", "feature^{tree}"),
    );
  });
});
