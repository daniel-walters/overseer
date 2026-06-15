import type { DispatchIssue } from "./reader.js";

/**
 * The inputs to a single implementor-prompt build: the Issue to implement (as
 * the dispatch reader produced it), its parent PRD's display title and body, and
 * the dispatch context (the target repo and the per-repo feature branch the
 * agent's worktree branches from).
 *
 * `repo` is a required non-empty string: only spawn candidates reach prompt
 * building, and the frontier has already skipped any Issue without a valid repo,
 * so there is nothing to default here.
 */
export interface ImplementorPromptInput {
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
  /** The code repository the agent works in (path or git URL). */
  readonly repo: string;
  /** The PRD feature branch the agent's worktree branches off. */
  readonly featureBranch: string;
}

/**
 * Slot-fill the single static implementor-prompt template from a dispatch Issue,
 * its parent PRD, and dispatch context.
 *
 * Deliberately a pure, deterministic function with no per-dispatch LLM
 * authoring: the same inputs always produce the same prompt, so an
 * auto-permission agent's brief is auditable on every run. The agent inherits an
 * Issue the dispatcher has *already* flipped to `in-progress`, so the template
 * never tells it to set that status — only to park the finished work at
 * `ready-for-review`, recording the worktree, branch, and (if it strayed) a
 * deviation in the same edit so the reviewer and merge can read them (ADR 0006).
 */
export function buildImplementorPrompt(input: ImplementorPromptInput): string {
  const { issue, prdTitle, prdBody, repo, featureBranch } = input;

  return `You are an autonomous implementor agent dispatched by Overseer.

You have been handed a single Issue to implement. The Issue has already been
marked as started — do not change that. Implement it fully, then advance it to
the review state as described below.

## Issue: ${issue.title}

${issue.body}

## Parent PRD: ${prdTitle}

${prdBody}

## Where the work happens

- Target repository: ${repo}
- PRD feature branch: ${featureBranch}

Work in an isolated git worktree branched off the feature branch
(${featureBranch}) in the target repository. Do all of your work in that
worktree so that other agents touching the same repo do not collide with you.

## How to finish

1. Drive the implementation with the \`tdd\` skill: work test-first in a
   red-green-refactor loop — write a failing test, make it pass, then refactor —
   before parking the Issue at \`ready-for-review\`. (A purely docs-only or
   config-only Issue with nothing to red-green is the lone exception.)
2. Implement the Issue in full.
3. Commit your work to the worktree. Do NOT open a pull request — the worktree
   itself is the review artifact.
4. When the implementation is complete, park the Issue for review with a single
   edit to its frontmatter in the Overseer root. The Issue file to edit is:

   ${issue.path}

   In that one edit:
   - Set \`status: ready-for-review\`. Stop here — do NOT advance the status any
     further. A later review step flips it onward; that is not your job.
   - Record \`worktree:\` set to the absolute path of the worktree you worked in,
     and \`branch:\` set to its branch name. Record both verbatim from the
     worktree you actually used — never guess or derive them. The reviewer
     checks out the worktree and merges the branch using exactly these values.
   - Record a \`deviation:\` field with a short reason ONLY IF you strayed from
     the Issue's planned approach to get the work done. If you followed the
     plan, omit the field entirely — its mere presence forces a human review.
     Quote the value (\`deviation: "..."\`) so a colon or other punctuation in
     your reason can't corrupt the Issue's frontmatter.

Leave the Issue at \`ready-for-review\`; a later reviewer step takes it from
there.`;
}
