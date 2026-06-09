import type { DispatchIssue } from "../dispatch/reader.js";
import {
  HUMAN_REVIEW_REASONS,
  type HumanReviewReason,
} from "../model.js";

/**
 * One-line guidance per escalation reason, keyed by the single-sourced
 * {@link HumanReviewReason} vocabulary so the prompt's reason tokens can never
 * drift from what the scanner accepts. A new reason is a compile error here
 * until it is given guidance.
 */
const REASON_GUIDANCE: Record<HumanReviewReason, string> = {
  deviation: "a deviation was recorded",
  "non-convergence": "the loop did not converge in 3 passes",
  conflict: "the merge hit a conflict",
};

/**
 * The inputs to a single reviewer-prompt build: the Issue to review (as the
 * dispatch reader produced it, carrying the implementor's recorded worktree,
 * branch, and any deviation), its parent PRD's display title and body, and the
 * PRD feature branch the clean path merges into.
 *
 * The Issue is guaranteed `ready-for-review` with a worktree and branch by the
 * eligibility classifier, and the review trigger has *already* flipped it to
 * `in-review` before this prompt is built, so the template never tells the
 * reviewer to set that status — only to drive the review to its terminal one.
 */
export interface ReviewerPromptInput {
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
  /** The PRD feature branch the clean path merges the worktree into. */
  readonly featureBranch: string;
}

/**
 * Slot-fill the single static reviewer-prompt template from an Issue, its parent
 * PRD, and the feature branch. The review counterpart to
 * {@link import("../dispatch/implementorPrompt.js").buildImplementorPrompt}:
 * deliberately pure and deterministic, with no per-review LLM authoring, so an
 * auto-permission reviewer's brief is auditable on every run.
 *
 * The brief encodes the whole review outcome (CONTEXT.md, "Review outcome"):
 * check out the recorded worktree; loop `/code-review` at medium effort up to a
 * hard cap of 3 passes, fixing findings as it goes, where convergence is a pass
 * that reports zero findings; on a converged clean pass with no recorded
 * deviation, merge the worktree branch into the PRD feature branch and set
 * `done`; on a recorded deviation, non-convergence after the cap, or a merge
 * conflict, set `human-review` and record `human_review_reason` (deviation /
 * non-convergence / conflict) so the card can surface why. The merge targets the
 * feature branch only, never `main`.
 *
 * Whether a deviation was recorded is baked into the prose so the reviewer knows
 * up-front which exit is even available: a recorded deviation forecloses the
 * clean auto-merge path entirely.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { issue, prdTitle, prdBody, featureBranch } = input;

  const reasonBullets = HUMAN_REVIEW_REASONS.map(
    (reason) => `  - \`human_review_reason: ${reason}\` — ${REASON_GUIDANCE[reason]}`,
  ).join("\n");

  const deviationNote =
    issue.deviation === undefined
      ? `No deviation was recorded by the implementor, so the clean auto-merge path below is available if the review converges cleanly.`
      : `A deviation WAS recorded by the implementor:

    ${issue.deviation}

  Because a deviation is present, the clean auto-merge path is foreclosed: after
  running the review loop you must set \`human-review\`, never \`done\`. A human
  resolves the deviation and runs the merge themselves.`;

  return `You are an autonomous reviewer agent dispatched by Overseer.

You have been handed a single Issue whose implementation is complete and awaiting
review. The Issue has already been moved into review — do not change that. Run the
review described below and drive the Issue to its terminal status.

## Issue: ${issue.title}

${issue.body}

## Parent PRD: ${prdTitle}

${prdBody}

## Where the work is

The implementor recorded its handoff on the Issue. Check out and review exactly
these — never guess or rederive them:

- Repository (run every git command here, with \`git -C ${issue.repo}\`): ${issue.repo}
- Worktree to review: ${issue.worktree}
- Branch to merge:    ${issue.branch}
- PRD feature branch: ${featureBranch}

${deviationNote}

## How to review

1. Check out the recorded worktree (${issue.worktree}) so you are reviewing the
   implementor's actual code.
2. Run the \`/code-review\` skill at MEDIUM effort and fix the findings it
   reports, committing the fixes to the worktree as you go. Then run it again.
   Repeat this loop. One iteration is a single \`/code-review\` pass plus its
   fixes; the loop CONVERGES when a pass reports zero findings.
3. The loop is capped at 3 passes. If a 3rd pass still reports findings, the
   review has NOT converged — stop looping and take the human-review exit below.

## How to finish

Edit the Issue's frontmatter in the Overseer root to record the terminal status.
The Issue file to edit is:

   ${issue.path}

Take exactly one of two exits:

- CLEAN EXIT — the loop converged (a pass reported zero findings) AND no
  deviation was recorded. Merge the worktree branch (${issue.branch}) into the
  PRD feature branch (${featureBranch}), then set \`status: done\` on the Issue.
  Run the merge in the repository itself, NOT from inside the worktree (whose
  HEAD is ${issue.branch}), so the merge direction is unambiguous:

      git -C ${issue.repo} checkout ${featureBranch}
      git -C ${issue.repo} merge --no-ff ${issue.branch}

  Merge ONLY into the feature branch; never merge into \`main\`. If the merge
  hits a conflict, do NOT resolve it — run \`git -C ${issue.repo} merge --abort\`
  and take the human-review exit instead (a sibling worktree moved the branch; a
  human reconciles it).

- HUMAN-REVIEW EXIT — any of: a deviation was recorded, the loop did not
  converge within 3 passes, or the merge hit a conflict. Do NOT merge. Set
  \`status: human-review\` on the Issue AND record \`human_review_reason\` so a
  human knows what attention it needs before opening it. Use exactly one of:
${reasonBullets}
  Then stop; a human takes it from there.`;
}
