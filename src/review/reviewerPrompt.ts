import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import {
  REVIEW_CATEGORIES,
  type ReviewConfig,
  type Tolerance,
} from "./reviewConfig.js";

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
   * prompt reads the `effort` (the pass runs `/code-review` at that effort) and the
   * `tolerance` policy (embedded so the agent can classify and grade findings — ADR
   * 0027). The `cap` is the Reactor's concern (ADR 0018): it enforces the
   * non-convergence escalation across passes, so the single-pass prompt never names
   * the cap as a loop bound.
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
 * changing anything (so the agent never reviews its own fixes); classify each
 * finding on two axes and grade it against the embedded tolerance policy (ADR
 * 0027); then take exactly one exit, decided by whether any *blocking* finding
 * remains:
 *
 * - **No blocking findings** → clean exit: write `review_verdict: clean` to the
 *   Issue frontmatter (and, if tolerable findings were waved through, a single-line
 *   `review_tolerated` manifest of what the merge carries), leave the status
 *   untouched, and stop. The agent does NOT merge and does NOT write a terminal
 *   status — Overseer reads the verdict, merges the worktree branch into the PRD
 *   feature branch, and marks the Issue `done`. Note "clean" means *no blocking
 *   findings*, not literally zero findings (ADR 0027).
 * - **Blocking findings** → fix them (and tolerable ones only when cheap and safe),
 *   commit to the worktree, record a one-line `review_findings` summary of what was
 *   fixed plus a disclosure of any tolerated findings and their classification, set
 *   `status: ready-for-review`, and stop, so the Reactor spawns the next pass.
 *
 * Tolerance is config injected into the prompt and applied *by the agent* — Overseer
 * never sees a Severity (ADR 0027): `clean` still means merge, the cap still means
 * escalate. Only the agent's threshold for writing `clean` moved, from "zero
 * findings" to "zero blocking findings". The resolved policy is embedded as a
 * per-Category maximum-Severity table; `none` means a Category always blocks.
 *
 * That `review_findings` summary is the findings ledger (ADR 0024): a fresh pass
 * reviews honestly precisely *because* it did not write the code, but blind to
 * what the prior pass flagged it cannot confirm those fixes actually landed. When
 * the Issue carries a prior pass's `review_findings`, the template grows a
 * "confirm the previous pass" section folding it in, so the new agent verifies
 * each is genuinely resolved (and that no fix regressed) as part of its own
 * review. On a findings exit the ledger *also* discloses what this pass tolerated
 * (with its classification) — framed for **independent re-judgment, not deference**
 * (ADR 0027): the confirm-the-previous-pass section tells the next agent to
 * re-judge the tolerated set itself, so a disagreement re-surfaces the finding.
 * The ledger is last-pass-only — each findings exit overwrites it — so the section
 * is absent on the first pass (no prior findings) and after a clean pass it is never
 * read (the clean exit is terminal; the merge's tolerated set rides `review_tolerated`
 * there, not the ledger). It rides the Issue frontmatter, the only channel a detached
 * `--bg` reviewer has back to Overseer, exactly as the implementor's `deviation` does.
 *
 * The cap / non-convergence escalation lives in the Reactor, not here, so the
 * prompt never counts passes or names the cap. The agent no longer reasons about
 * merges, the branch to merge, recorded deviations, conflicts, or a human-review
 * exit at all — those are Overseer's, downstream of the verdict.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { issue, prdTitle, prdBody, review } = input;
  const { effort, tolerance } = review;
  // The /code-review skill names effort in lowercase; the prompt has long
  // written it in caps for emphasis, so uppercase the configured value to match.
  const effortLabel = effort.toUpperCase();

  // The resolved tolerance policy (ADR 0027), embedded so the agent grades each
  // finding against it. Overseer never reads tolerance — the threshold reaches the
  // only actor that edits code, the agent, exactly as `effort` does.
  const toleranceTable = renderTolerance(tolerance);

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

That summary may also disclose findings the previous pass *tolerated* (with their
Category and Severity) rather than fixed. Re-judge each of those yourself against
the tolerance policy above — this is independent re-judgment, not deference: if you
disagree that one is tolerable, treat it as a finding of this pass.

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
3. Classify every finding \`/code-review\` reports on two axes. \`/code-review\`
   does not emit them; assigning them is your judgment:
   - **Category** (its kind): one of correctness, security, architecture, style,
     test, docs.
   - **Severity** (its grade): one of low, medium, high.
   Then judge each finding against the tolerance policy below: a finding is
   **blocking** if its Severity is above its Category's tolerated maximum (or that
   Category tolerates none), and **tolerable** otherwise.
4. Then take exactly one exit below, decided solely by whether any **blocking**
   findings remain.

## Tolerance policy

This board tolerates findings at or below a per-Category maximum Severity — what it
will accept into the merge rather than block on. \`none\` means that Category
tolerates nothing (fix everything in it). A finding whose Severity is above its
Category's maximum is blocking.

${toleranceTable}${priorFindingsSection}

## How to finish

Edit the Issue's frontmatter in the Overseer root to record this pass's outcome.
The Issue file to edit is:

   ${issue.path}

Take exactly one of these two exits, decided solely by whether any **blocking**
finding remains — tolerable findings never decide the exit:

- CLEAN EXIT — NO blocking findings remain (there may be tolerable findings you
  chose to leave). In a single edit, add the line \`review_verdict: clean\` to the
  Issue's frontmatter. If you tolerated any findings, also add a single-line,
  double-quoted \`review_tolerated\` manifest naming what the merge will carry and
  its classification (e.g.
  \`review_tolerated: "style:low formatter line length; docs:low stale comment"\`),
  on one line so the frontmatter stays valid YAML. Then stop. Do NOT change the
  \`status\` field and do NOT merge anything: Overseer reads the verdict, performs
  the merge into the feature branch, and writes the terminal status itself.

- FINDINGS EXIT — one or more BLOCKING findings remain. Fix every blocking finding,
  committing the fixes to the worktree (${issue.worktree}) as you go; fix tolerable
  findings too only when doing so is cheap and safe. Do NOT re-review your own
  fixes. Then make a single edit to the Issue frontmatter:
    - The Issue ALREADY has a \`status:\` line. CHANGE that existing line's value
      in place to \`ready-for-review\` — do NOT add a second \`status:\` line. After
      your edit there must be exactly ONE \`status:\` line: a duplicate key makes
      the frontmatter invalid YAML, and Overseer can no longer read the Issue (it
      drops off the board flagged with a bad-status warning).
    - Set \`review_findings\` to a one-line summary of the blocking findings you
      fixed this pass, written as a double-quoted string on one line (e.g.
      \`review_findings: "Unvalidated input in parser; missing test for the
      empty-list case"\`). If you tolerated any findings rather than fixing them,
      also disclose them and their Category/Severity in that same line, so the next
      pass sees what this pass waved through and can **re-judge** them with fresh
      eyes rather than rediscover them cold. This is disclosure for independent
      re-judgment, not deference: if the next pass disagrees a finding is tolerable,
      it treats it as a finding of its own. Keep it to one line and quote it so the
      frontmatter stays valid YAML. If a \`review_findings\` line already exists from
      an earlier pass, OVERWRITE that line in place rather than adding another — the
      same no-duplicate-keys rule applies to every field.
  That summary lets the fresh agent on the next pass confirm your fixes actually
  landed. Then stop — Overseer picks it back up and a fresh agent reviews your
  fixes in the next pass.`;
}

/**
 * Render the resolved {@link Tolerance} policy as a stable markdown list for the
 * prompt: one line per Category in {@link REVIEW_CATEGORIES} order, naming its
 * maximum tolerable Severity. `none` is annotated as always-blocking so the agent
 * reads it as "fix everything in this Category." The fixed Category order keeps the
 * prompt byte-stable for identical inputs (the determinism the test asserts).
 */
function renderTolerance(tolerance: Tolerance): string {
  return REVIEW_CATEGORIES.map((category) => {
    const level = tolerance[category];
    const annotation = level === "none" ? "none (always blocks)" : level;
    return `- ${category}: ${annotation}`;
  }).join("\n");
}
