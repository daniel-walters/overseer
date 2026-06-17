# The Reactor owns the review loop; each pass is a fresh spawn

## Status

accepted

## Context

The AI-review loop runs `/code-review` up to a configured cap (`config.review.cap`,
default 3), fixing findings between passes, escalating to `human-review` for
non-convergence (CONTEXT.md → Review outcome). Two things about today's design pull in
the same direction:

1. **The loop lives inside one agent's head.** A single reviewer is spawned once and
   loops internally up to the cap, writing back only a *terminal* status. The pass
   number exists nowhere Overseer can read — so the board cannot surface review progress
   (the `N/cap` marker idea), and the cap is enforced only by the agent counting
   correctly in-process.
2. **That single agent grades its own fixes.** It reviews, fixes its own findings, then
   re-reviews its own fixes — the classic author-reviewer bias. Convergence ("a pass
   reports zero findings") means less when the passing reviewer has a stake in the code.

ADR 0005 already decided the reactor runs **in-process** and is a strictly additive
layer over the review spawn edge. This ADR decides a different axis: **who owns the
loop** — the agent (internal looping) or the Reactor (per-pass spawns). It also touches
ADR 0008 (the agent sidecar), which holds Overseer's per-Issue operational state.

The alternative was to leave the loop in the agent and expose the count some other way —
either the agent writes the count into the Issue file (breaks the read-only-viewer
contract, ADR 0002, and adds mid-loop churn) or the agent writes it into the sidecar
(makes the agent a *second writer* to `agents.json`, racing Overseer's `record`, when
the sidecar's whole design is "only Overseer writes it").

## Decision

The **Reactor owns the review loop.** Each `/code-review` pass is its **own spawn** on
the *existing* review edge (`ready-for-review → in-review`) — a **fresh reviewer agent
per pass**. No new spawn edge: a trigger only ever exists on the two spawn edges
(CONTEXT.md → Status lifecycle).

- **Per pass, one agent reviews *then* fixes.** Independence comes from a fresh agent
  per pass, not from splitting review and fix across agents. The pass agent reviews the
  worktree *as it inherited it* (the previous pass's agent's code, or the implementor's
  on pass 1) — it has no stake in that code — and only then fixes. The agent that fixes
  in pass N is gone by pass N+1, so pass N+1's fresh agent reviews those fixes with no
  memory of making them. Every agent only ever *judges* code it did not write.
- **Between passes the Issue returns to `ready-for-review`.** A pass that found and
  fixed issues sets status back to `ready-for-review`; the Reactor's existing review
  frontier re-picks it up. **No new status** — the awaiting→active flip stays the
  idempotency lock.
- **The pass count lives in the agent sidecar (`agents.json`), written by Overseer at
  spawn time.** Because the Reactor drives each pass, Overseer increments and records
  the pass number alongside the handle — the **agent never writes the sidecar**, so the
  "only Overseer writes `agents.json`" invariant (ADR 0008) survives untouched. The
  value widens from `string` (handle) to `{ handle, reviewPass }`.
- **The count is both control and display.** The Reactor reads `reviewPass = N` for a
  `ready-for-review` Issue: if `N ≥ config.review.cap` it escalates to `human-review`
  (`non-convergence`) instead of spawning; otherwise it spawns pass `N+1` and records
  `N+1`. The card's `N/cap` marker is that same number.

## Consequences

- **The reviewer prompt becomes single-pass.** `reviewerPrompt.ts` is rewritten from a
  multi-pass loop to drive one pass: review first, then converge (merge→`done`, or
  `human-review` on a deviation) or fix-and-return (`ready-for-review`). The cap /
  non-convergence *bound* moves out of the prompt into the Reactor; the non-convergence
  *reason* guidance for the human-review exit stays.
- **The cap is now Reactor-enforced, not agent-enforced.** A non-converging loop
  reliably escalates after `cap` passes because Overseer counts, not because an agent
  counts correctly in its own head.
- **Cards visibly oscillate `ready-for-review ⇄ in-review`, one hop per pass.** Accepted
  as honest: the board column maps 1:1 to on-disk status (the pure-viewer invariant).
  Collapsing the hops to make a mid-loop card look settled was rejected — it would show
  a column that isn't the file's status.
- **More spawns, more cost.** N spawns per Issue instead of 1, each paying cold-start +
  worktree checkout. Bounded the same way ADR 0005 bounds the reactor: total passes are
  capped by `config.review.cap`, and flip-before-spawn prevents re-pickup, so there is
  no re-spawn cycle.
- **The human-review flow is unchanged.** All three reasons (`non-convergence`,
  `deviation`, `conflict`) and the single `human-review → done` exit via the merge skill
  are preserved exactly.
- **No standalone daemon, still in-process (ADR 0005 holds).** This ADR changes *what*
  the reactor reconciles per pass, not *where* it runs.
