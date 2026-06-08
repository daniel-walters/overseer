import type { IssueRecord, PrdRecord } from "./records.js";

/**
 * The inputs to a single implementor-prompt build: the Issue to implement, its
 * parent PRD, and the dispatch context (the target repo and the per-repo
 * feature branch the agent's worktree branches from).
 */
export interface ImplementorPromptInput {
  readonly issue: IssueRecord;
  readonly prd: PrdRecord;
  /** The code repository the agent works in (path or git URL). */
  readonly repo: string;
  /** The PRD feature branch the agent's worktree branches off. */
  readonly featureBranch: string;
}

/**
 * Slot-fill the single static implementor-prompt template from an Issue + PRD
 * record and dispatch context.
 *
 * Deliberately a pure, deterministic function with no per-dispatch LLM
 * authoring: the same inputs always produce the same prompt, so an
 * auto-permission agent's brief is auditable on every run. The agent inherits an
 * Issue the dispatcher has *already* flipped to `in-progress`, so the template
 * never tells it to set that status — only to advance the work to `in-review`
 * when finished.
 */
export function buildImplementorPrompt(input: ImplementorPromptInput): string {
  const { issue, prd, repo, featureBranch } = input;

  return `You are an autonomous implementor agent dispatched by Overseer.

You have been handed a single Issue to implement. The Issue has already been
marked as started — do not change that. Implement it fully, then advance it to
the review state as described below.

## Issue: ${issue.title}

${issue.body}

## Parent PRD: ${prd.title}

${prd.body}

## Where the work happens

- Target repository: ${repo}
- PRD feature branch: ${featureBranch}

Work in an isolated git worktree branched off the feature branch
(${featureBranch}) in the target repository. Do all of your work in that
worktree so that other agents touching the same repo do not collide with you.

## How to finish

1. Implement the Issue in full.
2. Commit your work to the worktree. Do NOT open a pull request — the worktree
   itself is the review artifact.
3. When the implementation is complete, advance the Issue to the review state by
   writing \`status: in-review\` into the Issue's frontmatter in the Overseer
   root. The Issue file to edit is:

   ${issue.path}

Leave the Issue at the review state; a later reviewer step takes it from there.`;
}
