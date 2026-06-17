import type { DispatchIssue } from "../dispatch/reader.js";
import {
  HUMAN_REVIEW_REASONS,
  type HumanReviewReason,
} from "../model.js";
import type { ReviewConfig } from "./reviewConfig.js";

/**
 * The escalation reason the Reactor — not the pass agent — owns. The Reactor
 * drives the loop (ADR 0018), so it escalates `non-convergence` when the pass
 * cap is reached; the single-pass prompt never records it.
 */
type ReactorOwnedReason = "non-convergence";

/**
 * The human-review escalation reasons this single-pass prompt actually records:
 * the two outcomes a pass agent can observe within one pass — a recorded
 * `deviation` or a merge `conflict` on the clean exit. Derived from the
 * single-sourced {@link HumanReviewReason} vocabulary (with the Reactor-owned
 * reason excluded) so the prompt's reason tokens can never drift from what the
 * scanner accepts: a new reason is a compile error in {@link REASON_GUIDANCE}
 * until it is given guidance.
 */
type PromptOwnedReason = Exclude<HumanReviewReason, ReactorOwnedReason>;

/**
 * One-line guidance per escalation reason the pass agent owns. `non-convergence`
 * is deliberately absent — that escalation moved to the Reactor (ADR 0018).
 */
const REASON_GUIDANCE: Record<PromptOwnedReason, string> = {
  deviation: "a deviation was recorded",
  conflict: "the merge hit a conflict",
};

/**
 * The prompt-owned reasons in their canonical vocabulary order, filtered from
 * the single source so the bullet list and the type stay in lockstep.
 */
const PROMPT_OWNED_REASONS: readonly PromptOwnedReason[] =
  HUMAN_REVIEW_REASONS.filter(
    (reason): reason is PromptOwnedReason => reason !== "non-convergence",
  );

/**
 * The inputs to a single reviewer-prompt build: the Issue to review (as the
 * dispatch reader produced it, carrying the implementor's recorded worktree,
 * branch, and any deviation), its parent PRD's display title and body, and the
 * PRD feature branch the clean path merges into, and the resolved review knobs.
 *
 * The Issue is guaranteed `ready-for-review` with a worktree and branch by the
 * eligibility classifier, and the review trigger has *already* flipped it to
 * `in-review` before this prompt is built, so the template never tells the
 * reviewer to set that status — only to drive this one pass to its exit.
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
   * The resolved review knobs from {@link import("../config.js").Config}. The
   * prompt reads only the `effort` — the pass runs `/code-review` at that effort.
   * The `cap` is the Reactor's concern now (ADR 0018): it enforces the
   * non-convergence escalation across passes, so the single-pass prompt never
   * names the cap as a loop bound.
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
 * The brief drives exactly **one** review pass (ADR 0018 — the Reactor owns the
 * loop and spawns a fresh agent per pass): check out the implementor's recorded
 * worktree; review it *first* by running `/code-review` at the configured effort
 * on the code *as inherited*, before changing anything (so the agent never
 * reviews its own fixes); then take exactly one exit:
 *
 * - **Zero findings, no deviation** → clean exit: merge the worktree branch into
 *   the PRD feature branch and set `done`. A merge conflict aborts and escalates
 *   to `human-review` with `conflict`; a recorded deviation forecloses the merge
 *   and escalates with `deviation`.
 * - **Findings** → fix them, commit to the worktree, and set status back to
 *   `ready-for-review` so the Reactor spawns the next pass.
 *
 * The cap / non-convergence escalation lives in the Reactor, not here, so the
 * prompt never counts passes or names the cap as a loop bound. The two
 * escalation exits the pass agent *does* own (deviation, conflict) still record
 * `human_review_reason` + a free-text `human_review_note` so the user can read
 * *why*. The merge targets the feature branch only, never `main`.
 *
 * Whether a deviation was recorded is baked into the prose so the reviewer knows
 * up-front which exit is even available: a recorded deviation forecloses the
 * clean auto-merge path entirely.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { issue, prdTitle, prdBody, featureBranch, review } = input;
  const { effort } = review;
  // The /code-review skill names effort in lowercase; the prompt has long
  // written it in caps for emphasis, so uppercase the configured value to match.
  const effortLabel = effort.toUpperCase();

  const reasonBullets = PROMPT_OWNED_REASONS.map(
    (reason) => `  - \`human_review_reason: ${reason}\` — ${REASON_GUIDANCE[reason]}`,
  ).join("\n");

  const deviationNote =
    issue.deviation === undefined
      ? `No deviation was recorded by the implementor, so the clean auto-merge path below is available if this pass reports zero findings.`
      : `A deviation WAS recorded by the implementor:

    ${issue.deviation}

  Because a deviation is present, the clean auto-merge path is foreclosed: even
  if this pass reports zero findings you must set \`human-review\`, never
  \`done\`. A human resolves the deviation and runs the merge themselves. When
  you write the \`human_review_note\` at that exit, FOLD this implementor
  deviation note into it so there is one coherent "why" — do not leave the human
  two separate notes to reconcile. (Leave the implementor's raw \`deviation\`
  frontmatter field on the Issue untouched; it is an audit trail the dispatch
  reader still consumes.)`;

  return `You are an autonomous reviewer agent dispatched by Overseer.

You have been handed a single Issue whose implementation is complete and awaiting
review. The Issue has already been moved into review — do not change that. Run
the single review pass described below and drive the Issue to this pass's exit.

This is ONE pass of the review. Overseer decides whether another pass runs: when
you hand an Issue back for more work, a fresh agent picks up the next pass. Do
NOT re-run the review yourself — run it once, then take exactly one exit.

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

## How to review (one pass)

1. Check out the recorded worktree (${issue.worktree}) so you are reviewing the
   code as you inherited it — written by the implementor (or by a previous pass's
   agent). You did NOT write this code; review it on its own terms.
2. Review FIRST, before changing anything: run the \`/code-review\` skill at
   ${effortLabel} effort on the worktree exactly as inherited. Reviewing before
   you touch the code is what keeps the review honest — you never grade your own
   fixes.
3. Then take exactly one exit below based on what the review reported.

## How to finish

Edit the Issue's frontmatter in the Overseer root to record this pass's status.
The Issue file to edit is:

   ${issue.path}

Take exactly one of these exits:

- CLEAN EXIT — the review reported ZERO findings AND no deviation was recorded.
  Merge the worktree branch (${issue.branch}) into the PRD feature branch
  (${featureBranch}), then set \`status: done\` on the Issue. Run the merge in
  the repository itself, NOT from inside the worktree (whose HEAD is
  ${issue.branch}), so the merge direction is unambiguous:

      git -C ${issue.repo} checkout ${featureBranch}
      git -C ${issue.repo} merge --no-ff ${issue.branch}

  Merge ONLY into the feature branch; never merge into \`main\`. If the merge
  hits a conflict, do NOT resolve it — run \`git -C ${issue.repo} merge --abort\`
  and take the human-review exit with reason \`conflict\` (a sibling worktree
  moved the branch; a human reconciles it).

- FINDINGS EXIT — the review reported one or more findings (and no deviation was
  recorded). Fix every finding, committing the fixes to the worktree
  (${issue.worktree}) as you go. Do NOT re-review your own fixes and do NOT
  merge. Then set \`status: ready-for-review\` on the Issue and stop. Overseer
  picks it back up and a fresh agent reviews your fixes in the next pass.

- HUMAN-REVIEW EXIT — a deviation was recorded, or the merge on the clean exit
  hit a conflict. Do NOT merge. In a single edit to the Issue's frontmatter, set
  \`status: human-review\` AND record BOTH of these so a human knows what
  attention it needs before opening it:

  1. \`human_review_reason\` — the category, exactly one of:
${reasonBullets}
  2. \`human_review_note\` — a free-text explanation of the specifics: what the
     review actually found or what the merge hit. Write this for BOTH reasons,
     regardless of which one you recorded — especially for a conflict, which
     otherwise carries no prose at all (e.g. "merging into ${featureBranch} hit a
     conflict in src/auth.ts; a sibling worktree moved the branch"). For a
     deviation, FOLD the implementor's recorded deviation note (shown above) into
     this single note so there is one coherent "why". Quote the value
     (\`human_review_note: "..."\`) so a colon or other punctuation can't corrupt
     the frontmatter.

  Then stop; a human takes it from there.`;
}
