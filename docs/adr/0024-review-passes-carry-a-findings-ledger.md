# Review passes carry a findings ledger across the loop

## Status

accepted

## Context

After [ADR 0018](./0018-reactor-owns-the-review-loop-not-the-agent.md) the review
loop spawns a **fresh agent per pass**, and after
[ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md) that agent
has two exits: **clean** (write `review_verdict: clean`, stop) or **findings** (fix
+ commit to the worktree, set `status: ready-for-review`, stop). The fresh-agent
rule is deliberate — a pass reviews honestly precisely because it did *not* write
the code it is grading, so it never reviews its own fixes
(`reviewerPrompt.ts` → reviews FIRST, before changing anything).

That same rule has a blind spot. A pass-N findings exit fixes what it found and
hands the work back, but records **nothing about what it found**. Pass N+1 is a
fresh agent with zero knowledge of pass N's findings, so it cannot *confirm* those
specific fixes landed — it can only run another full `/code-review` and hope to
re-surface the same problems. Two failure modes follow:

- **Unverified fixes.** A subtle or partial fix (the right line touched, the bug
  still latent) only gets caught if the next blind sweep happens to flag it again.
  Findings do not accumulate, so a fix is never explicitly checked for closure.
- **Slow convergence.** Each pass re-derives the picture from scratch. With a cap
  of 3 (`reviewConfig.ts`), a loop that "almost converges" can burn a whole pass
  re-finding what the last pass already knew.

The fix is continuity: let pass N+1 see what pass N flagged, *without* letting any
agent grade its own fixes. The constraint that shapes the design: a reviewer is a
detached `claude --bg` process. Overseer does not watch it; its **only** channel
back is editing files in the watched root, which ride the existing debounced
rescan. The agents sidecar (`agentSidecar.ts`) is Overseer-only — an agent cannot
write it — so the sidecar cannot *receive* a finding the agent never put in a file
first. This is the same reasoning [ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md)
used to put `review_verdict` in frontmatter rather than a worktree artifact.

The alternatives weighed:

- **Sidecar ledger.** Tempting (Overseer already keeps `reviewPass` there), but the
  agent can't write the sidecar, so it would need Overseer to *harvest* findings
  from frontmatter into the sidecar at spawn time anyway — strictly more moving
  parts for the same agent-side write. Rejected for the first cut.
- **Full cross-pass history.** Accumulate every pass's findings (in the sidecar)
  to detect oscillation (pass 1 flags X, pass 2 "fixes" it, pass 3 flags X again).
  Real value, but with cap 3 there is little history to accumulate, and it needs
  the harvest step above. Deferred — last-pass-only is an additive base for it.
- **Findings in the Issue body.** Can't corrupt frontmatter, but the body is the
  spec (sacred), and it is already injected into the prompt verbatim — review notes
  would pollute it permanently. Rejected.
- **A structured (multiline / list) frontmatter value.** A malformed multiline
  value blanks the *whole* frontmatter via `safeMatter` (status, repo, worktree all
  read absent — the Issue effectively vanishes from classification). The
  implementor's `deviation` field already lives with this risk by being a
  single-line string; the ledger inherits the same contract rather than widening
  the blast radius.

## Decision

**Carry the prior pass's findings forward in a `review_findings` frontmatter field
— agent-written, single-line, last-pass-only.**

- **The findings exit gains one write.** A findings-exit pass, in the same edit
  that sets `status: ready-for-review`, sets `review_findings` to a **one-line,
  double-quoted** summary of what it fixed. The clean exit is unchanged (it found
  nothing, and is terminal — Overseer merges, no next pass reads it).

- **The reviewer prompt grows a conditional "confirm the previous pass" section.**
  When the Issue carries a `review_findings`, the template folds it in *after* the
  `/code-review` step, asking the fresh agent to verify each prior finding is
  genuinely resolved (and that no fix regressed) as part of its own review — never
  to re-grade its own work. With no prior findings (the first pass, or a blank
  field) the section drops out and the prompt is byte-for-byte the pre-ledger one.

- **Last-pass-only.** Each findings exit overwrites `review_findings`, so the field
  always holds exactly the immediately preceding pass's findings. No history
  accumulates and no sidecar slot is added.

- **Read like `deviation`.** `reader.ts` reads `review_findings` via
  `readPresentString` (blank ⇒ absent), and `issueFile.ts` registers the field name
  once in `FIELD`. The fresh-agent independence rule
  ([ADR 0018](./0018-reactor-owns-the-review-loop-not-the-agent.md)) is preserved:
  the agent that *wrote* the fixes never reads the ledger to grade them — the next
  agent does.

## Consequences

- **Unverified fixes get an explicit closure check** and the loop tends to converge
  in fewer passes, without weakening the no-grading-your-own-fixes invariant.
- **Zero new persistence surface.** No sidecar schema change, no harvest step, no
  change to `resolveVerdict`, `sweep`, the cap, the verdict bit, or who owns the
  merge. The change is confined to the field registry, the reader, and the prompt.
- **The findings exit now writes two fields where it wrote one.** A malformed
  `review_findings` could blank the frontmatter via `safeMatter` exactly as a
  malformed `deviation` can today — which is why the contract is single-line and
  quoted. The deferred "tolerant verdict parse + stale-`in-review` sweep" reliability
  slice is the backstop for this whole class and would cover it too.
- **A done Issue keeps its last `review_findings`** as a harmless audit trail of
  what the final findings pass fixed. A manual `r` re-review of an Issue that still
  carries an old `review_findings` would surface stale context to the prompt —
  acceptable (and usually still useful), not a wedge.
- **Full cross-pass history stays open** as a later, additive slice: harvest each
  pass's `review_findings` into the sidecar at spawn time and widen the prompt
  section to the whole arc. Nothing here forecloses it.
- **CONTEXT.md → Review outcome** should gain a `review_findings` term when this
  ships, alongside the existing `review_verdict`.
