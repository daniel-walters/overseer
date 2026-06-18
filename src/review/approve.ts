import { basename, join } from "node:path";
import { Status } from "../dispatch/status.js";
import { readDispatchIssue, hasValue } from "../dispatch/reader.js";
import { featureBranchName } from "../dispatch/gitSetup.js";
import { writeStatus as realWriteStatus } from "../issueFile.js";
import {
  mergeWorktree as realMergeWorktree,
  cleanUpWorktree as realCleanUpWorktree,
  realMergeSeam,
} from "./mergeSeam.js";
import type { MergeInput, MergeResult } from "./mergeSeam.js";
import type { Approve } from "../ui/App.js";
import type { ApprovePreviewData } from "../ui/ApprovePreview.js";

/**
 * The **Approve** action handler (PRD: Approve from Board, ADR 0021): the deep,
 * isolated piece behind the `A` keybind that finishes a `human-review` Issue from
 * inside the board. It is the **second caller** of the same in-process merge op the
 * Reactor's clean-AI path runs (`mergeWorktree` + `cleanUpWorktree`, ADR 0019) —
 * not a new merge, and **not** routed through {@link
 * import("./resolveVerdict.js").resolveVerdict}, whose deviation/conflict routing is
 * the Reactor's concern. A `human-review` Issue has no clean `review_verdict` to
 * gate on; the human's press *is* the "should we merge?" decision (the grilled
 * decision: extract the inner op, triggers own their routing — exactly as `d`/`r`/
 * the Reactor share `spawnWithFlip`).
 *
 * Pure over its injected {@link ApproveDeps} (the two inner-op functions + a
 * `writeStatus` writer) — no Ink, no real git/fs of its own — so it is unit-tested
 * with a fake `MergeSeam` exactly like `resolveVerdict`, minus the verdict/deviation
 * routing. The App owns turning the returned {@link ApproveResult} into a board move
 * (`merged`) or a status-line message (`dirty` / `conflict`); the merge target is
 * the PRD feature branch the App derived with the existing `featureBranchName` rule.
 */

/**
 * The handoff the Approve merge reads off the selected `human-review` Issue, plus
 * its PRD feature branch. The same shape as {@link MergeInput} — Approve and the
 * Reactor's resolve feed the identical inner op — carried as its own type so the
 * App constructs it from the resolved Issue fields explicitly.
 */
export interface ApproveInput {
  /** The repo every git command runs in (`git -C repo`). */
  readonly repo: string;
  /** The Issue's recorded worktree, verified clean by the inner op before merge. */
  readonly worktree: string;
  /** The Issue's recorded branch, merged into the feature branch. */
  readonly branch: string;
  /** Absolute path to the Issue file the clean merge writes `status: done` to. */
  readonly path: string;
  /** The PRD feature branch the worktree branch merges into (`featureBranchName`). */
  readonly featureBranch: string;
}

/**
 * The seams the Approve handler depends on, injected for tests (real in
 * production). The two merge functions are the **existing** inner op from
 * {@link import("./mergeSeam.js")} — Approve calls them directly, the same ones
 * `resolveVerdict` calls — so the two human/AI merge paths can never drift in
 * feature-branch derivation, conflict handling, or cleanup (PRD user story 15).
 */
export interface ApproveDeps {
  /** Run the clean merge of the worktree branch into the feature branch. */
  readonly mergeWorktree: (input: MergeInput) => MergeResult;
  /** Tear down the merged worktree + branch (best-effort, after the done write). */
  readonly cleanUpWorktree: (input: MergeInput) => void;
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
}

/**
 * The outcome of an Approve, mapped by the App to one of two surfaces: `merged`
 * (the card moves to `done` via the live re-scan, unblocking `blocked_by`
 * siblings), or `dirty` / `conflict` (a loud status-line message, the Issue left
 * exactly where it was in `human-review`). Distinct from {@link MergeResult}: the
 * inner op's transient-or-dirty `failure` collapses into `dirty` here (the dirty
 * worktree is overwhelmingly the human case — "commit your fix first"), and there
 * is no terminal-status side carried because the App never writes on a non-clean
 * result. **No `suppressed` outcome**: a dirty/conflicting tree means "work
 * happened, I'm not finished" (which `human-review` already means), never the
 * transient "nothing completed, retry on reopen" suppression is reserved for (ADR
 * 0011 / PRD user story 8).
 */
export type ApproveResult =
  | { readonly kind: "merged" }
  | { readonly kind: "dirty" }
  | { readonly kind: "conflict" };

/**
 * Approve a clean-mergeable `human-review` Issue: run the inner merge op, and on a
 * clean result write `status: done` then tear down the worktree. On a dirty
 * worktree or a real conflict, write nothing and leave the Issue in `human-review`
 * — the App surfaces a loud status-line message and the card never moves.
 *
 * Forks on the inner op's {@link MergeResult}:
 * - `merged` → write `status: done` (the durable idempotency lock, like
 *   flip-before-spawn) then `cleanUpWorktree` — best-effort, *after* the durable
 *   write so a crash between merge and cleanup leaks a worktree, not a wedged
 *   Issue. Returns `merged`.
 * - `conflict` → the inner op already aborted the merge; write nothing, clean up
 *   nothing (the worktree survives for the human), return `conflict`.
 * - `failure` (a dirty worktree or a transient git error) → write nothing, clean
 *   up nothing, return `dirty`.
 *
 * Total like `resolveVerdict`: a vanished Issue file (ENOENT on the `done` write)
 * is swallowed — the merge is idempotent (`--no-ff`), so re-pressing `A` retries —
 * and nothing escapes to crash the Ink input handler.
 */
export function approve(input: ApproveInput, deps: ApproveDeps): ApproveResult {
  const mergeInput: MergeInput = {
    repo: input.repo,
    worktree: input.worktree,
    branch: input.branch,
    featureBranch: input.featureBranch,
  };
  const result = deps.mergeWorktree(mergeInput);

  if (result.outcome === "conflict") return { kind: "conflict" };
  if (result.outcome !== "merged") return { kind: "dirty" };

  try {
    deps.writeStatus(input.path, Status.DONE);
  } catch {
    // The Issue file vanished after the merge landed. The merge is idempotent
    // (--no-ff), so re-pressing retries; do NOT clean up (the Issue is not done
    // yet — its worktree must survive), and never throw out of the input handler.
    return { kind: "merged" };
  }
  deps.cleanUpWorktree(mergeInput); // best-effort, after the durable `done` lock
  return { kind: "merged" };
}

/**
 * Production {@link ApproveDeps}: the **real** inner merge op + the real
 * `writeStatus`. The two merge functions are the same `mergeWorktree` /
 * `cleanUpWorktree` the Reactor's `resolveVerdict` runs, bound to the production
 * `realMergeSeam` (shelling out to git) — so Approve and the clean-AI path can never
 * drift (PRD user story 15). A test passes a fake-`MergeSeam`-backed deps instead.
 */
export function realApproveDeps(): ApproveDeps {
  return {
    mergeWorktree: (input) => realMergeWorktree(input, realMergeSeam),
    cleanUpWorktree: (input) => realCleanUpWorktree(input, realMergeSeam),
    writeStatus: realWriteStatus,
  };
}

/**
 * Build the production {@link Approve} the App drives at the Issue level — the `A`
 * keybind's seam, the merge-bearing sibling of {@link
 * import("../dispatch/markDone.js").createMarkDone}. It resolves a (PRD id, Issue
 * id) into an {@link ApprovePreviewData} (the plan strings the confirm states + the
 * frozen merge handoff) and, on confirm, runs {@link approve} over that handoff.
 *
 * `readApprove` reads the Issue via the dispatch reader (so it parses the recorded
 * `repo`/`worktree`/`branch` identically to every other edge) and derives the PRD
 * feature branch from the PRD directory basename via the existing
 * {@link featureBranchName} rule — never re-implemented, so it matches the Reactor's
 * merge target and the `/overseer-merge` skill exactly. A vanished PRD/Issue, or one
 * missing the handoff (a card that raced a re-scan, or an A pressed off-target),
 * yields `undefined` — the preview renders nothing and `A` is a harmless no-op,
 * mirroring how the review/kill/mark-done seams degrade a vanished target.
 */
export function createApprove(root: string, deps: ApproveDeps): Approve {
  return {
    readApprove(prdId: string, issueId: string): ApprovePreviewData | undefined {
      const prdDir = join(root, prdId);
      try {
        const issue = readDispatchIssue(prdDir, issueId);
        // The merge handoff must be present — the same fields the eligibility
        // overlay gates `A` on. Without all three there is nothing to merge, so the
        // preview opens nothing (defence-in-depth behind the keybind gate).
        if (
          !hasValue(issue.repo) ||
          !hasValue(issue.worktree) ||
          !hasValue(issue.branch)
        ) {
          return undefined;
        }
        return {
          issueTitle: issue.title,
          issuePath: issue.path,
          repo: issue.repo,
          worktree: issue.worktree,
          branch: issue.branch,
          featureBranch: featureBranchName(basename(prdDir)),
        };
      } catch {
        // The PRD dir or the Issue file vanished from the watched root.
        return undefined;
      }
    },

    approve(preview: ApprovePreviewData): ApproveResult {
      return approve(
        {
          repo: preview.repo,
          worktree: preview.worktree,
          branch: preview.branch,
          path: preview.issuePath,
          featureBranch: preview.featureBranch,
        },
        deps,
      );
    },
  };
}
