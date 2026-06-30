# The auditor is a third spawn edge that judges plan-conformance

## Status

accepted

## Context

A [Deviation](../../CONTEXT.md#deviation) — the implementation straying from the
Issue's planned approach — is the signal that forces a human review rather than
an AI-only one. Until now the **implementor wrote its own `deviation` field** in
the same edit that flipped the Issue to `ready-for-review`
(`implementorPrompt.ts`). That has the same author-reviewer bias
[ADR 0018](./0018-reactor-owns-the-review-loop-not-the-agent.md) identified for
the review loop: an agent judging whether *its own* code strayed from the plan is
grading its own homework. It under-reports (the implementor rationalises its
choices as faithful) and the report is unverifiable — nothing else ever compares
the diff against the plan.

Two further problems compounded it:

1. **Deviation detection ran too late and collided with non-convergence.**
   `deviation` was only acted on at the resolve step, *after* the AI review loop.
   An Issue that both deviated *and* failed to converge hit `escalate.ts` first
   and was escalated as `non-convergence`, **masking** the deviation — the single
   `human_review_reason` field can only name one cause, so CONTEXT.md's claim that
   the three reasons are mutually exclusive was a slight lie.
2. **No leeway.** A bare "did you stray?" instruction flags trivially — a variable
   renamed to dodge a clash reads as a deviation, sending clean work to a human
   for no reason.

The hard constraint in the way: the pipeline had **"two — and only two — spawn
edges"** (implementation, review), an invariant
[ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md) went out
of its way to protect by making the verdict-resolve step a *non-spawn* reconcile.
A dedicated agent that runs after the implementor and before the reviewer is, by
definition, a third spawn.

### Considered options

- **Leave detection in the implementor, add leeway to its prompt.** Cheapest, but
  keeps the author-reviewer bias — the whole reason to move it. Rejected.
- **Fold the audit into the review edge as a distinguished first pass** (no new
  status, reuse the reviewer spawn, pass 0 = audit). Preserves the two-edge
  invariant, but special-cases the sidecar pass counter (the audit pass must not
  count toward `review.cap` or corrupt the `N/cap` marker), branches the prompt
  builder on pass number, conflates the auditor and reviewer roles/config on one
  edge, and oscillates `ready-for-review ⇄ in-review` purely to run the audit.
  Lighter on status surface, heavier on per-edge logic. Rejected in favour of a
  uniform edge.
- **Make the deviation skip the AI review loop.** Considered as a way to save the
  review spend on code headed for a human anyway. Rejected: it would make
  deviating code the *one* class that ships un-AI-reviewed, reversing the
  twice-stated "a human only ever sees better code (AI cleaned it first)" value;
  and the `human-review → done`-only exit has no "now run review" escape hatch.

## Decision

**Introduce the auditor as a genuine third spawn edge.**

- A new awaiting→active status pair, **`ready-for-audit` → `in-audit`**, sits
  between implementation and review. The implementor now stops at
  `ready-for-audit` (recording `worktree`/`branch` as before, but **no longer
  `deviation`**). The audit trigger flips `ready-for-audit → in-audit` and spawns
  the **auditor**, a fresh agent that checks out the recorded worktree, compares
  the diff against the plan (Issue body + PRD), writes `deviation` (or nothing),
  and **unconditionally** flips `in-audit → ready-for-review`. The reviewer edge
  is unchanged downstream.

  The "exactly N spawn edges" invariant becomes **three**, not two — but the
  invariant's *substance* (flip-before-spawn idempotency, bounded spawns, no
  re-spawn cycle, level-triggered reconcile) holds for the new edge exactly as for
  the other two. "Two" was incidental — there happened to be two phases.

- **The auditor is fresh-eyes, the same independence argument as ADR 0018.** It
  judges code it did not write. Plan-conformance is precisely the judgment the
  implementor cannot make about itself.

- **Leeway is the auditor's contract.** It flags a Deviation only when the
  implementation *conflicts with, omits, or materially exceeds something the plan
  specified* — affecting behaviour, scope, public interface, dependencies, or a
  design decision the plan made. Incidental, behaviour-preserving differences
  (naming, including renames forced by a clash; helper extraction; file layout;
  import order; refactors within the planned approach) are **never** flagged.
  Choices the plan left open are never deviations. On a *substantive* difference
  the auditor is unsure about, it **leans toward flagging** — a human glance is
  cheap; silent scope drift to auto-merge is not.

- **Deviation now takes precedence.** Because the auditor writes `deviation`
  *before* any review pass, it is present at both escalation points.
  `resolveVerdict.ts` already reads it before the merge (so it beats `conflict`);
  `escalate.ts` gains the same deviation-first check (so it beats
  `non-convergence`). The three `human_review_reason` values
  (`deviation` / `non-convergence` / `conflict`) become genuinely mutually
  exclusive — fixing the masking bug.

- **The Issue still runs the AI review loop regardless** of a recorded Deviation
  (decision unchanged from today). A Deviation changes the *destination*
  (`human-review` instead of auto-merge), not whether review runs.

- **The auditor defaults to `opus`** even when unconfigured — a deliberate
  divergence from the implementor/reviewer edges (which default to inherit per
  [ADR 0020](./0020-per-edge-agent-model-and-effort-are-configurable.md)). The
  auditor is the gate against silent scope drift, so it must be strong by default,
  not only when someone remembers to set it. An optional `[auditor]` table
  (`model`/`effort`) overrides it, mirroring 0020.

## Consequences

- **Plan-conformance is now an independent, verifiable judgment**, no longer the
  author's self-report.
- **The board grows one column.** `ready-for-audit` and `in-audit` render as a
  single combined **`audit`** column (8 Issue columns), the active/waiting split
  carried by the existing liveness overlay — unlike the review phase's two-column
  split, because the audit is a single near-instant pass, not a queue-forming
  loop.
- **A new manual crank, `c`** (issue-level, eligible on `ready-for-audit`), mirrors
  `r`, so a hand-stepped pipeline (auto-run off) doesn't jam at the new phase.
- **All Reactor machinery extends uniformly** — a third frontier, the failed-set
  `audit` edge key, the `⊘ suppressed` marker on the `audit` lane, orphan
  detection over `in-audit`, `K`/`o` on a live auditor. No new mechanism, just the
  spawn-edge pattern applied a third time.
- **One more spawn per Issue.** Bounded the same way the others are
  (flip-before-spawn, one pass), paid for by catching scope drift before it
  auto-merges and by removing the implementor's self-grading bias.
- **The "two spawn edges" invariant is reversed** — recorded here because a future
  reader will assume two and find three.
