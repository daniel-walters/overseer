# The Approve keybind shares the Reactor's merge seam

## Status

accepted

## Context

[ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md) moved the
clean-AI merge in-process: the Reactor's resolve step verifies a clean worktree,
`git merge --no-ff`es the Issue's branch into the PRD feature branch, writes
`status: done`, and removes the worktree. That ADR's own Consequences flagged the
slice this ADR decides: *"The human `overseer-merge` skill is now a candidate to
re-back onto the same TS merge seam … a separate, deferred slice."*

The friction that forced it: an Issue in `human-review` (a recorded
[Deviation](../../CONTEXT.md#deviation), a `conflict`, or `non-convergence`) has a
**single exit — `done`-via-merge** — but that exit lived *only* in the
[`overseer-merge`](../../CONTEXT.md#review-outcome) skill, which is markdown for an
agent, not callable from the board. So a human who read the deviation in the `v`
detail view and agreed had to leave Overseer, open `claude agents`, find the right
instance, run the skill, and return. The merge Overseer *already runs itself* on the
clean-AI path was, for the human path, a four-step context-switch out of the board.

The decision splits along two axes a reader would otherwise conflate:

- **What is shared.** The Reactor's resolve step is *routing* (check
  `review_verdict`, send a [Deviation](../../CONTEXT.md#deviation) to `human-review`,
  decide merge-vs-conflict-escalate) **wrapping** an inner merge+`done`+cleanup. A
  human approve must skip the routing — the human *is* the routing decision — and call
  only the inner op, from `human-review`, on an Issue that by definition carries **no**
  clean verdict. Pointing the keybind at the *whole* resolve step breaks immediately:
  it is verdict-gated (human-review Issues have none) and would bounce a deviation
  straight back to `human-review`.

- **What gates it.** Eligibility is deliberately **reason-agnostic**, not
  `deviation`-only. A `conflict` or `non-convergence` Issue that the human hand-fixes
  in the worktree becomes mergeable but **keeps its original
  `human_review_reason`** (Overseer never rewrites it — it is an audit trail). Gating
  the keybind on the reason would leave those fixed Issues un-approvable from the board,
  preserving the exact friction for two of the three roads into `human-review`. The
  thing that actually makes an Issue approvable is not *why* it arrived but whether the
  **worktree is clean and merges without conflict** — which the merge op already checks.

## Decision

**Add an `A` (Approve) keybind that runs the same in-process merge op the Reactor's
clean path runs — human-triggered instead of verdict-triggered.**

- **Extract the inner merge op** from the Reactor's resolve step: verify worktree
  clean → `git -C repo checkout <feature> && git merge --no-ff <branch>` →
  `writeStatus(done)` → `git worktree remove` + `branch -d`. The Reactor calls it
  *after* its verdict/deviation routing decides "merge now"; `A` calls it *directly*
  from `human-review`. One merge implementation, two callers, each owning its own
  "should we merge?" gate — exactly parallel to how `spawnWithFlip` is shared while
  `d`/`r`/the Reactor each own their own eligibility.

- **`A` is reason-agnostic**, [eligible](../../CONTEXT.md#eligibility) on **any**
  `human-review` Issue carrying a recorded `worktree` + `branch`. The merge op is the
  gate.

- **Uppercase `A`, with a confirm preview.** It is an outward write (merge to the
  feature branch) plus worktree/branch deletion, so it joins the heavy shift-keyed
  family (`K`/`R`/`X`), not the cheap `m`/`d`/`r` one. The preview **states the plan**
  — `merge <branch> → <feature-branch>`, mark `<issue>` done, remove worktree
  `<path>` — exactly as `X` and the spawn previews state their action; it does **not**
  render the diff (that is a separate detail-view capability, not bolted onto a confirm
  modal).

- **A merge that cannot proceed is a loud status-line message, not a state change.**
  A dirty worktree (uncommitted fix) or a real conflict leaves the Issue in
  `human-review` and surfaces "commit your fix first" / "resolve the conflict first."
  This is **not** [Suppressed](../../CONTEXT.md#suppressed): suppression is for
  *transient, nothing-completed, retry-on-reopen* failures; a dirty/conflicting tree on
  a human press is *"work happened, you are not finished"* — which is precisely what
  `human-review` already means. Reopening the board would not fix it, so it earns no
  `⊘` marker and writes nothing.

## Consequences

- **`human-review`'s single exit is now a keybind.** The clean-AI auto-merge and the
  human approve are the *same* operation behind two triggers — the symmetry
  [ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md) set up,
  finally closed on the human side.
- **The `overseer-merge` skill is kept, not retired.** A `conflict`/`non-convergence`
  Issue that needs real hand-fixing is *already* a leave-the-board activity (you are
  editing the worktree in a session), so finishing with the skill in that same session
  stays natural. `A` is the in-board fast path for the mergeable case; the skill is the
  out-of-board path. They are **not** code-shared (the skill is markdown), so they must
  stay *behaviorally* identical — same feature-branch derivation
  ([ADR 0006](./0006-issues-carry-their-worktree-and-branch.md)), same conflict-abort —
  the standing coupling the skill's careful derivation rule already guards.
- **The board gains its second human-triggered terminal write** (after
  [Mark done](../../CONTEXT.md#mark-done)'s `m`), and its first human-triggered
  *outward git write*. Unlike `m` (a cheap, reversible `writeStatus` flip), `A` merges
  and deletes — hence the shift key and the confirm, consistent with `X`/`K`.
- **The "exactly two spawn edges" invariant is untouched** — `A` merges and writes a
  terminal status but **does not spawn**, exactly like the Reactor's resolve step it
  shares code with.
