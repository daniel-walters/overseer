# Tolerance lives in the reviewer prompt; the agent grades findings, Overseer's control flow is unchanged

## Status

accepted

## Context

The AI-review loop (ADR 0018 — Reactor owns the loop; ADR 0019 — Overseer owns
the merge and terminal write; ADR 0024 — passes carry a findings ledger) treats
findings as **binary**: a pass finds zero (clean → Overseer merges) or ≥1 (fix
*everything*, loop), and after `config.review.cap` passes still finding things
Overseer escalates to `human-review` with `non-convergence`. The failure mode this
ADR addresses: a loop that *won't die over trivia* — a `style:low` nit a fresh pass
keeps re-surfacing burns the cap and escalates to a human, spending the scarcest
resource (human attention) on something nobody would ask a human to look at.

We want a **graded** merge: findings classified on two axes — **Severity**
(`low/medium/high`) and **Category** (`correctness/security/architecture/style/test/docs`)
— and a **tolerance** policy that lets the loop converge and merge when the only
remaining findings are mild enough, instead of looping or escalating. The axes are
asymmetric: **Category gates, Severity grades** (a `security:low` finding is not the
same as a `style:low` one), so tolerance is a per-Category maximum-Severity table,
not a single global severity bar. The retired shorthand "nit" was conflating the two
axes (a kind *and* a grade); it maps to a low-Severity `style` finding.

The tension: ADRs 0018/0019 deliberately pushed **judgment and policy out of the
agent and into Overseer** (the agent reports one bit; Overseer counts passes, owns
escalation and merge), precisely so the loop can't be wedged by an agent reasoning
wrongly. A graded merge decision is exactly the kind of judgment those ADRs distrust
in the agent. So where does the tolerance policy live?

## Decision

**Tolerance is config injected into the reviewer prompt; the agent applies it during
the pass. Overseer's control flow is left completely unchanged.**

- **The policy is a `[review.tolerance]` TOML sub-table** (per-Category max tolerable
  Severity; `none` = always blocks), resolved alongside `cap`/`effort` and embedded in
  the prompt exactly as `effort` already is.
- **The agent grades and applies.** Because the agent is the only actor that edits
  code, the threshold *has* to reach it to drive what it fixes. So the agent
  classifies each `/code-review` finding onto the two axes (the axes are *ours*;
  `/code-review` does not emit them), fixes blocking findings, leaves tolerable ones,
  and writes `review_verdict: clean` once no *blocking* findings remain.
- **Overseer never sees a severity.** `clean` still means "merge"; the cap still means
  "escalate." `resolveVerdict`, the Reactor, and the pass counter are untouched. Only
  the agent's *threshold for writing `clean`* moved (from "zero findings" to "zero
  blocking findings"). The hard line ADR 0018/0019 drew survives: only *classification*
  judgment moved into the agent, never the merge/escalate control flow.
- **Applied every pass, not just the last.** Tolerance is the loop's convergence
  criterion: the loop converges as soon as only tolerable findings remain (possibly
  pass 1), and `non-convergence` fires only when genuinely *blocking* findings persist
  for `cap` passes.
- **The merge's tolerated findings are recorded** in a single-line `review_tolerated`
  field at the clean exit (same contract as `deviation`/`review_findings`), driving a
  neutral `done`-card marker. Mid-loop, a findings exit also *discloses* the tolerated
  set forward in `review_findings` — **for independent re-judgment, never deference**:
  the next fresh pass is told what was waved through and re-judges it, so disclosure is
  an extra safety check, not a bias.
- **Default policy:** tolerate `style`/`docs` at `low`, everything else `none`.

## Considered options

- **Overseer as the policy engine** (agent emits per-finding severities as data;
  Overseer reads them and applies the threshold at merge/escalate). Rejected: it needs
  *structured/multiline* frontmatter, which ADR 0024 showed blanks the whole file via
  `safeMatter`; and it double-sources the threshold (the agent still needs it to decide
  what to *fix*), so one policy would live in two places.
- **Tolerance only on the final pass** (a cap-time safety valve, matching the original
  "if only low nits are left, merge instead of escalating" phrasing). Rejected: it
  forces Overseer to inspect per-finding severities at the cap (the policy-engine design
  above) and splits convergence into two pass-number-dependent rules. Every-pass
  tolerance delivers the same outcome with no new machinery and fewer spawns.

## Consequences

- **`clean` no longer means literally zero findings** — it means no *blocking* findings.
  A `done` Issue may carry `review_tolerated` recording what the merge waved through.
- **Classification is non-deterministic across fresh agents.** Accepted, not fought: a
  finding flipping to blocking gets fixed (good); a tolerable one conservatively fixed
  is harmless. The bounded churn is the cost of fresh-eyes independence (ADR 0018); the
  ledger disclosure dampens wasteful cold re-discovery without importing the prior call.
- **The merge now trusts the agent's *classification*.** This is a real softening of
  ADR 0018's "agent emits minimum data" line — but it softens classification, not
  control flow. A category important enough to want a human's eyes should set its
  tolerance to `none` (stays blocking), never "tolerable-but-flag."
- **The reviewer prompt and `ReviewConfig` grow; `resolveVerdict`/Reactor/cap do not.**
- **CONTEXT.md gains** the `Finding`, `Severity`, `Category`, and `Tolerance` terms, and
  the `review_verdict`/`review_findings` terms are amended.
