# Overseer owns the review merge and the terminal status write

## Status

accepted

## Context

After [ADR 0018](./0018-reactor-owns-the-review-loop-not-the-agent.md) the Reactor
owns the review *loop* — each `/code-review` pass is a fresh spawn — but the **clean
exit is still the agent's job**: a pass that reviews clean must itself run
`git merge --no-ff` into the PRD feature branch and write `status: done`
(`reviewerPrompt.ts` → How to finish).

A real dogfood run (2026-06-17) showed why that is fragile. Issue 002 of the
`reviewer-iteration-count` PRD got **wedged in `in-review`**: the reviewer ran
`/code-review`, found nothing, committed — and then simply *stopped*, never running
the merge+`done` hop. The work sat committed, the merge was conflict-free, no deviation
was recorded — a textbook clean exit — yet the Issue stayed `in-review` forever and had
to be finished by hand with `overseer-merge`.

The cause is structural, not a flaky run. Overseer flips `ready-for-review → in-review`
*before* spawning (the idempotency lock, [ADR 0002](./0002-agents-write-the-root-viewer-stays-readonly.md)),
and the Reactor only reconciles the `ready-for-review` frontier — so once an Issue is
`in-review` the Reactor never touches it again. The agent is the **only** thing that
ever writes the terminal status. A reviewer that dies, runs out of turns, or just stops
after reviewing but before the merge+`done` hop leaves the Issue stuck with no retry and
no board signal. ADR 0018 does **not** fix this: even under per-pass spawns, the clean
exit is still the agent's, so a pass agent that stops before the merge wedges
identically.

This ADR decides a different axis from 0018. 0018 decided *who drives the passes* (the
Reactor); this decides *who writes the terminal state and runs the merge* (Overseer).

The alternatives weighed:

- **Verdict transport.** A worktree artifact (`.overseer/verdict.json`) is natural for
  the agent but fires no rescan in the watched root, so the Reactor would need a separate
  poll to notice it. Parsing the agent's `claude --bg` output breaks the fire-and-forget
  model (Overseer doesn't watch agent processes; liveness is only a membership query).
  A frontmatter field rides the existing debounced rescan in-band.
- **"Agents mustn't write the Issue."** This framing is wrong: agents already write the
  Issue (the implementor writes `ready-for-review` + worktree + branch + `deviation`).
  [ADR 0002](./0002-agents-write-the-root-viewer-stays-readonly.md) forbids the *viewer*
  writing, not agents. The real constraint is that the **terminal status and the merge**
  must be Overseer's, deterministic.
- **Merge owner.** The `overseer-merge` skill is markdown for an agent/human, not
  callable TypeScript — "using" it from the TUI means spawning an agent, which can die
  before finishing (the exact wedge). A thin "merge-only" spawned agent is self-defeating
  for the same reason. The merge must be in-process TS.
- **Where to escalate a transient merge failure.** Routing it to `human-review` would
  resurrect the rejected "launch failures go to the human queue" path
  ([Reactor](../../CONTEXT.md#reactor) — a spawn failure is never `human-review`).

## Decision

**Move the merge and the terminal status write off the agent and into Overseer.**

- **The pass agent's contract shrinks to two exits, no git, no terminal status.** It
  reviews the worktree as inherited, then either:
  - **clean** (zero findings) → writes `review_verdict: clean` to the Issue frontmatter,
    leaves `status: in-review`, stops; or
  - **findings** → fixes + commits to the worktree, writes `status: ready-for-review`,
    stops (unchanged from ADR 0018; the Reactor re-picks it up).

  The reviewer prompt loses its deviation-reasoning branch, its merge instructions, and
  its human-review exit — it no longer reasons about deviations or merges at all.

- **`review_verdict` is a single value, `clean`.** It is the one thing Overseer cannot
  derive: did *this* pass find zero findings? Everything else Overseer already has —
  `deviation` from the implementor's frontmatter, `conflict` from running the merge
  itself, `non-convergence` from its own pass counter (`escalate.ts`).

- **The Reactor gains a non-spawn "resolve verdict" reconcile step.** After the two spawn
  frontiers, each reconcile scans `in-review` Issues carrying `review_verdict: clean` and
  resolves each — **gated on the verdict, not on liveness**, so it is independent of the
  lingering-completed-row liveness quirk:
  - `deviation` present → `writeHumanReview(deviation)`, no merge.
  - else → an in-process git-merge seam (mirroring the dispatcher's `GitSeam` in
    `gitSetup.ts`) following the `overseer-merge` sequence: verify worktree clean →
    `git -C repo checkout <feature> && git merge --no-ff <branch>` → `writeStatus(done)`
    → `git worktree remove` + `branch -d`. A conflict → `git merge --abort` →
    `writeHumanReview(conflict)`.
  - The merge runs **synchronously**, guarded by the existing reconcile re-entrancy
    guard. `writeStatus(done)` is the durable idempotency lock (it removes the Issue from
    the verdict frontier, exactly as flip-before-spawn does), and `merge --no-ff` is
    naturally idempotent, so a board crash mid-merge recovers by simply re-running.
  - A transient (non-conflict) merge failure is handled like a spawn-launch failure:
    leave the Issue at `in-review` + verdict, append to the durable log, and add it to
    the session **failed-set** under a `resolve` edge so it is subtracted from the verdict
    frontier and does not re-attempt (or re-block the UI) this session. Reopening the
    board retries. **Never** `human-review`.

- **The `⊘ suppressed` marker's lane-gating widens to the `in-review` lane** for the
  resolve edge, so a suppressed merge is visible rather than a silent wedge. It outranks
  the neutral `N/cap` marker, mirroring how Orphan outranks the count.

## Consequences

- **The whole "agent reviewed but never finished" class is killed at the source.** The
  clean path is Overseer-owned and deterministic — it either completes or visibly fails
  (suppressed marker), never silently half-completes.
- **The residual wedge window shrinks to one frontmatter write and is already covered.**
  An agent that dies before writing `review_verdict` (or before the findings
  `ready-for-review` flip) lands as an existing `in-review` **Orphan** (recorded handle,
  dead, no verdict); `R` rolls it back. The doc's proposed interim stalled-`in-review`
  detector is **subsumed**, not built separately.
- **Overseer gains its first non-spawn Reactor action and its first Overseer-owned
  terminal status write + outward git write to a repo.** The "exactly two **spawn**
  edges" invariant survives literally — resolving a verdict does not spawn. The git write
  extends the seam `gitSetup.ts` already owns rather than inventing one.
- **The clean-AI path now cleans up its worktree.** Today's reviewer-prompt clean exit
  merges + sets `done` but never removes the worktree; adopting the `overseer-merge`
  sequence fixes that leak.
- **The human `overseer-merge` skill is now a candidate to re-back onto the same TS merge
  seam** (one merge implementation, the skill a thin caller) — a separate, deferred slice,
  not part of this change.
- **CONTEXT.md → Review outcome must be rewritten** when this ships (the clean merge is
  Overseer's, not the agent's) and a `review_verdict` term added. Deferred to the
  implementing PRD so the canonical doc never describes unbuilt behavior.
- **Still in-process, no daemon** ([ADR 0005](./0005-review-reactor-runs-in-process-only.md)
  holds). This changes *what* the Reactor does per reconcile, not *where* it runs.
