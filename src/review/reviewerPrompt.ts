import type { DispatchIssue } from "../dispatch/reader.js";
import {
  HUMAN_REVIEW_REASONS,
  type HumanReviewReason,
} from "../model.js";
import type { ReviewConfig } from "./reviewConfig.js";

/**
 * One-line guidance per escalation reason, keyed by the single-sourced
 * {@link HumanReviewReason} vocabulary so the prompt's reason tokens can never
 * drift from what the scanner accepts. A new reason is a compile error here
 * until it is given guidance. The non-convergence guidance names the configured
 * pass `cap` (see {@link ReviewConfig}) so it always matches the loop's own cap.
 */
function reasonGuidance(cap: number): Record<HumanReviewReason, string> {
  return {
    deviation: "a deviation was recorded",
    "non-convergence": `the loop did not converge in ${cap} passes`,
    conflict: "the merge hit a conflict",
  };
}

/**
 * The inputs to a single reviewer-prompt build: the Issue to review (as the
 * dispatch reader produced it, carrying the implementor's recorded worktree,
 * branch, and any deviation), its parent PRD's display title and body, and the
 * PRD feature branch the clean path merges into, and the resolved review knobs.
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
  /**
   * The resolved review knobs (pass cap + effort) from {@link import("../config.js").Config}.
   * The cap is the single value both the loop instruction and the non-convergence
   * guidance read, so a later iteration-count marker can read the same number
   * rather than a duplicated literal.
   */
  readonly review: ReviewConfig;
}

/**
 * Slot-fill the single static reviewer-prompt template from an Issue, its parent
 * PRD, and the feature branch. The review counterpart to
 * {@link import("../dispatch/implementorPrompt.js").buildImplementorPrompt}:
 * deliberately pure and deterministic, with no per-review LLM authoring, so an
 * auto-permission reviewer's brief is auditable on every run.
 *
 * The brief encodes the whole review outcome (CONTEXT.md, "Review outcome"):
 * check out the recorded worktree; loop `/code-review` at the configured effort
 * (default medium) up to the configured hard cap (default 3 passes), fixing
 * findings as it goes, where convergence is a pass
 * that reports zero findings; on a converged clean pass with no recorded
 * deviation, merge the worktree branch into the PRD feature branch and set
 * `done`; on a recorded deviation, non-convergence after the cap, or a merge
 * conflict, set `human-review` and record both `human_review_reason` (the
 * category — deviation / non-convergence / conflict — that drives the card
 * marker) and a free-text `human_review_note` (the specifics, written for all
 * three reasons; for a deviation it folds in the implementor's own deviation
 * note) so the user can read *why*. The merge targets the feature branch only,
 * never `main`.
 *
 * Whether a deviation was recorded is baked into the prose so the reviewer knows
 * up-front which exit is even available: a recorded deviation forecloses the
 * clean auto-merge path entirely.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { issue, prdTitle, prdBody, featureBranch, review } = input;
  const { cap, effort } = review;
  // The /code-review skill names effort in lowercase; the prompt has long
  // written it in caps for emphasis, so uppercase the configured value to match.
  const effortLabel = effort.toUpperCase();

  const guidance = reasonGuidance(cap);
  const reasonBullets = HUMAN_REVIEW_REASONS.map(
    (reason) => `  - \`human_review_reason: ${reason}\` — ${guidance[reason]}`,
  ).join("\n");

  const deviationNote =
    issue.deviation === undefined
      ? `No deviation was recorded by the implementor, so the clean auto-merge path below is available if the review converges cleanly.`
      : `A deviation WAS recorded by the implementor:

    ${issue.deviation}

  Because a deviation is present, the clean auto-merge path is foreclosed: after
  running the review loop you must set \`human-review\`, never \`done\`. A human
  resolves the deviation and runs the merge themselves. When you write the
  \`human_review_note\` at that exit, FOLD this implementor deviation note into it
  so there is one coherent "why" — do not leave the human two separate notes to
  reconcile. (Leave the implementor's raw \`deviation\` frontmatter field on the
  Issue untouched; it is an audit trail the dispatch reader still consumes.)`;

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
2. Run the \`/code-review\` skill at ${effortLabel} effort and fix the findings it
   reports, committing the fixes to the worktree as you go. Then run it again.
   Repeat this loop. One iteration is a single \`/code-review\` pass plus its
   fixes; the loop CONVERGES when a pass reports zero findings.
3. The loop is capped at ${cap} passes. If pass number ${cap} still reports
   findings, the review has NOT converged — stop looping and take the
   human-review exit below.

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
  converge within ${cap} passes, or the merge hit a conflict. Do NOT merge. In a
  single edit to the Issue's frontmatter, set \`status: human-review\` AND record
  BOTH of these so a human knows what attention it needs before opening it:

  1. \`human_review_reason\` — the category, exactly one of:
${reasonBullets}
  2. \`human_review_note\` — a free-text explanation of the specifics: what the
     agent actually did or found. Write this for ALL three reasons, regardless of
     which one you recorded — especially for non-convergence and conflict, which
     otherwise carry no prose at all (e.g. "after ${cap} passes the auth test
     still failed intermittently; couldn't isolate the race"). For a deviation,
     FOLD the implementor's recorded deviation note (shown above) into this single
     note so there is one coherent "why". Quote the value
     (\`human_review_note: "..."\`) so a colon or other punctuation can't corrupt
     the frontmatter.

  Then stop; a human takes it from there.`;
}
