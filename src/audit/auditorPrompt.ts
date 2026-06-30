import type { DispatchIssue } from "../dispatch/reader.js";

/**
 * The inputs to a single auditor-prompt build: the Issue to audit (as the
 * dispatch reader produced it, carrying the implementor's recorded worktree) and
 * its parent PRD's display title and body. The auditor compares the worktree diff
 * against the plan — the Issue body + its PRD — so both bodies travel here, the
 * same pair the implementor and reviewer prompts carry.
 *
 * The audit trigger has *already* flipped the Issue to `in-audit` before this
 * prompt is built (flip-before-spawn, ADR 0002 / 0026), so the template never
 * tells the agent to set that status — only to flip it onward to
 * `ready-for-review` when its single audit pass is done.
 */
export interface AuditorPromptInput {
  readonly issue: DispatchIssue;
  /** The parent PRD's display title. */
  readonly prdTitle: string;
  /** The parent PRD's markdown body. */
  readonly prdBody: string;
}

/**
 * Slot-fill the single static auditor-prompt template from an Issue and its
 * parent PRD. The audit counterpart to
 * {@link import("../dispatch/implementorPrompt.js").buildImplementorPrompt} and
 * {@link import("../review/reviewerPrompt.js").buildReviewerPrompt}: deliberately
 * pure and deterministic, with no per-audit LLM authoring, so an auto-permission
 * auditor's brief is auditable on every run.
 *
 * The brief is a fresh-eyes plan-conformance check (ADR 0026), not a code review.
 * The agent: checks out the implementor's recorded worktree; compares the diff
 * against the plan (the Issue body + its PRD); applies the **leeway rubric** —
 * flag a `deviation` *only* when the implementation conflicts with, omits, or
 * materially exceeds something the plan specified (affecting behaviour, scope,
 * public interface, dependencies, or a design decision the plan made), and
 * *never* for incidental behaviour-preserving differences (naming including
 * clash-forced renames, helper extraction, file layout, import order, refactors
 * within the planned approach), leaning toward flagging on substantive
 * uncertainty; writes a quoted `deviation: "..."` field *only* on a meaningful
 * divergence (otherwise nothing); and **unconditionally** flips `in-audit →
 * ready-for-review`.
 *
 * It contains no code-review, no merge, and no terminal-status instruction: the
 * auditor judges plan-conformance only. The reviewer (downstream) judges code
 * quality, and Overseer owns the merge and the terminal status write.
 */
export function buildAuditorPrompt(input: AuditorPromptInput): string {
  const { issue, prdTitle, prdBody } = input;

  return `You are an autonomous auditor agent dispatched by Overseer.

You have been handed a single Issue whose implementation is complete. The Issue
has already been moved into the audit phase — do not change that. You are a
fresh pair of eyes: you did NOT write this code. Your one job is to judge whether
the implementation is faithful to the plan, record a deviation if (and only if)
it meaningfully strayed, then hand the Issue on to review.

You do NOT review code quality, you do NOT change any code, and you do NOT touch
any status other than the one onward flip described below. Plan-conformance is
your whole brief; the downstream reviewer judges the code itself.

## Issue: ${issue.title}

${issue.body}

## Parent PRD: ${prdTitle}

${prdBody}

## Where the work is

The implementor recorded its handoff on the Issue. Inspect exactly these — never
guess or rederive them:

- Repository (run every git command here, with \`git -C ${issue.repo}\`): ${issue.repo}
- Worktree to audit: ${issue.worktree}

## How to audit (one pass)

1. Check out the recorded worktree (${issue.worktree}) so you are inspecting the
   code exactly as the implementor left it.
2. Compare the worktree diff against **the plan** — the Issue body and its parent
   PRD above. The plan is what the implementor was asked to build; the diff is
   what they actually built.
3. Apply the **leeway rubric** to decide whether the difference is a deviation:

   - Flag a deviation **only** when the implementation **conflicts with, omits, or
     materially exceeds something the plan specified** — affecting behaviour,
     scope, public interface, dependencies, or a design decision the plan made.
   - **Never** flag incidental, behaviour-preserving differences: naming
     (including a variable renamed to dodge a clash), an equivalent helper
     extraction, file layout, import order, or any refactor within the planned
     approach. A choice the plan left open is never a deviation.
   - On a *substantive* difference you are genuinely unsure about, **lean toward
     flagging** — a cheap human glance is better than silent scope drift.

## How to finish

Edit the Issue's frontmatter in the Overseer root. The Issue file to edit is:

   ${issue.path}

In a single edit, do BOTH of the following:

- **If, and only if, you found a meaningful divergence:** add a \`deviation\` line
  recording it as a short, double-quoted, one-line reason — e.g.
  \`deviation: "Added a caching layer the plan never specified"\`. Quote the value
  so a colon or other punctuation in your reason cannot corrupt the frontmatter.
  If you found no meaningful divergence, **omit the field entirely** — its mere
  presence forces a human to look, so never write it for an incidental difference.
- **Unconditionally** — whether or not you recorded a deviation — flip the Issue's
  status. It ALREADY has a \`status:\` line reading \`in-audit\`. CHANGE that
  existing line's value in place to \`ready-for-review\` — do NOT add a second
  \`status:\` line. After your edit there must be exactly ONE \`status:\` line: a
  duplicate key makes the frontmatter invalid YAML and Overseer can no longer read
  the Issue.

Then stop. Recording the deviation (or not) and flipping \`in-audit →
ready-for-review\` is the entire audit pass.`;
}
