import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import type { ReviewConfig } from "./reviewConfig.js";

/**
 * The inputs to a single reviewer-prompt build: the Issue to review (as the
 * dispatch reader produced it, carrying the implementor's recorded worktree),
 * its parent PRD's display title and body, and the resolved review knobs.
 *
 * The Issue is guaranteed `ready-for-review` with a worktree by the eligibility
 * classifier, and the review trigger has *already* flipped it to `in-review`
 * before this prompt is built, so the template never tells the reviewer to set
 * that status — only to drive this one pass to its exit.
 *
 * Note what is deliberately absent: the PRD feature branch and the branch to
 * merge. Since ADR 0019 the pass agent never merges — Overseer owns the merge
 * and the terminal status write — so the prompt no longer carries a merge target
 * at all.
 */
export interface ReviewerPromptInput {
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
  /**
   * The resolved review knobs from {@link import("../config.js").Config}. The
   * prompt reads only the `effort` — the pass runs `/code-review` at that effort.
   * The `cap` is the Reactor's concern (ADR 0018): it enforces the
   * non-convergence escalation across passes, so the single-pass prompt never
   * names the cap as a loop bound.
   */
  readonly review: ReviewConfig;
}

/**
 * Slot-fill the single static reviewer-prompt template from an Issue, its parent
 * PRD, and the review knobs. The review counterpart to
 * {@link import("../dispatch/implementorPrompt.js").buildImplementorPrompt}:
 * deliberately pure and deterministic, with no per-review LLM authoring, so an
 * auto-permission reviewer's brief is auditable on every run.
 *
 * The brief drives exactly **one** review pass with a contract shrunk to two
 * exits (ADR 0019 — Overseer owns the merge and the terminal status write, ADR
 * 0018 — the Reactor owns the loop and spawns a fresh agent per pass): check out
 * the implementor's recorded worktree; review it *first* by running
 * `/code-review` at the configured effort on the code *as inherited*, before
 * changing anything (so the agent never reviews its own fixes); then take
 * exactly one exit:
 *
 * - **Zero findings** → clean exit: write `review_verdict: clean` to the Issue
 *   frontmatter, leave the status untouched, and stop. The agent does NOT merge
 *   and does NOT write a terminal status — Overseer reads the verdict, merges the
 *   worktree branch into the PRD feature branch, and marks the Issue `done`.
 * - **Findings** → fix them, commit to the worktree, record a one-line
 *   `review_findings` summary of what was fixed, set `status: ready-for-review`,
 *   and stop, so the Reactor spawns the next pass.
 *
 * That `review_findings` summary is the findings ledger (ADR 0024): a fresh pass
 * reviews honestly precisely *because* it did not write the code, but blind to
 * what the prior pass flagged it cannot confirm those fixes actually landed. When
 * the Issue carries a prior pass's `review_findings`, the template grows a
 * "confirm the previous pass" section folding it in, so the new agent verifies
 * each is genuinely resolved (and that no fix regressed) as part of its own
 * review. The ledger is last-pass-only — each findings exit overwrites it — so
 * the section is absent on the first pass (no prior findings) and after a clean
 * pass it is never read (the clean exit is terminal). It rides the Issue
 * frontmatter, the only channel a detached `--bg` reviewer has back to Overseer,
 * exactly as the implementor's `deviation` does.
 *
 * The cap / non-convergence escalation lives in the Reactor, not here, so the
 * prompt never counts passes or names the cap. The agent no longer reasons about
 * merges, the branch to merge, recorded deviations, conflicts, or a human-review
 * exit at all — those are Overseer's, downstream of the verdict.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { issue, prdTitle, prdBody, review } = input;
  const { effort } = review;
  // The /code-review skill names effort in lowercase; the prompt has long
  // written it in caps for emphasis, so uppercase the configured value to match.
  const effortLabel = effort.toUpperCase();

  // The findings ledger (ADR 0024): when a prior pass recorded what it fixed,
  // fold it in so this fresh agent confirms closure. Absent on the first pass —
  // a blank/missing field reads as undefined, so the section simply drops out and
  // the first pass is byte-for-byte the pre-ledger prompt. Placed after the
  // `/code-review` step so the review-before-fix ordering is undisturbed.
  const priorFindingsSection = hasValue(issue.reviewFindings)
    ? `

## Confirm the previous pass

A previous review pass reported and addressed the findings below, then handed the
work back. You did not write those fixes, so confirm them: as part of the review
above, verify each is genuinely resolved in the code you inherited, and that no
fix introduced a regression. Treat anything still open, or any regression, as a
finding of this pass.

Previous pass's findings:

${issue.reviewFindings}`
    : "";

  return `You are an autonomous reviewer agent dispatched by Overseer.

You have been handed a single Issue whose implementation is complete and awaiting
review. The Issue has already been moved into review — do not change that. Run
the single review pass described below and drive the Issue to this pass's exit.

This is ONE pass of the review. Overseer decides whether another pass runs: when
you hand an Issue back for more work, a fresh agent picks up the next pass. Do
NOT re-run the review yourself — run it once, then take exactly one exit.

You only ever review and report. You do NOT merge anything and you do NOT write a
terminal status: Overseer owns the merge into the feature branch and the final
\`done\` write. Your whole job is to run one review pass and report one bit — was
it clean, or did it need more work?

## Issue: ${issue.title}

${issue.body}

## Parent PRD: ${prdTitle}

${prdBody}

## Where the work is

The implementor recorded its handoff on the Issue. Check out and review exactly
these — never guess or rederive them:

- Repository (run every git command here, with \`git -C ${issue.repo}\`): ${issue.repo}
- Worktree to review: ${issue.worktree}

## How to review (one pass)

1. Check out the recorded worktree (${issue.worktree}) so you are reviewing the
   code as you inherited it — written by the implementor (or by a previous pass's
   agent). You did NOT write this code; review it on its own terms.
2. Review FIRST, before changing anything: run the \`/code-review\` skill at
   ${effortLabel} effort on the worktree exactly as inherited. Reviewing before
   you touch the code is what keeps the review honest — you never grade your own
   fixes.
3. Then take exactly one exit below based on what the review reported.${priorFindingsSection}

## How to finish

Edit the Issue's frontmatter in the Overseer root to record this pass's outcome.
The Issue file to edit is:

   ${issue.path}

Take exactly one of these two exits:

- CLEAN EXIT — the review reported ZERO findings. In a single edit, add the line
  \`review_verdict: clean\` to the Issue's frontmatter and stop. Do NOT change the
  \`status\` field and do NOT merge anything: Overseer reads the verdict, performs
  the merge into the feature branch, and writes the terminal status itself. Adding
  the verdict and stopping is the entire clean exit.

- FINDINGS EXIT — the review reported one or more findings. Fix every finding,
  committing the fixes to the worktree (${issue.worktree}) as you go. Do NOT
  re-review your own fixes. Then, in a single edit to the Issue frontmatter, set
  \`status: ready-for-review\` AND set \`review_findings\` to a one-line summary of
  the findings you fixed this pass, written as a double-quoted string on one line
  (e.g. \`review_findings: "Unvalidated input in parser; missing test for the
  empty-list case"\`). Keep it to one line and quote it so the frontmatter stays
  valid YAML. That summary lets the fresh agent on the next pass confirm your
  fixes actually landed. Then stop — Overseer picks it back up and a fresh agent
  reviews your fixes in the next pass.`;
}
