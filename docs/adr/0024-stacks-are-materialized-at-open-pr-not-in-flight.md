# Stacked PRs are materialized at Open PR time, not built in-flight

## Status

accepted

## Context

A PRD's whole diff can be too large for one human to review comfortably when it finally lands into `main` at a big company. When that is true *and* the work splits cleanly, we want **Open PR** (CONTEXT.md) to open a **stack** of smaller, coherent PRs instead of one — a downstream-readability feature, nothing more. A [Slice](../../CONTEXT.md) is the unit: a named, ordered group of Issues that becomes one PR in the stack, recorded as a `slice: N-name` field that [overseer-to-issues](#) authors.

The question this ADR settles is **when the branch topology of the stack comes into existence.** Two shapes were on the table:

1. **In-flight.** Make slices real branches during dispatch: slice-2's implementor worktrees branch off slice-1's branch, slice-3 off slice-2, and each implementor's PR targets its slice branch. The stack exists as branches the whole time the work is being built.
2. **At Open PR.** Keep today's model untouched — every implementor worktree branches off the single PRD feature branch and merges back into it (CONTEXT.md → Status lifecycle) — and only at the human's **Open PR** keypress, *after the whole PRD is `done`*, cut per-slice branches from the feature branch's own history and open the stack.

The existing pipeline dispatches every unblocked `ready-for-agent` Issue **in parallel** into isolated worktrees off one feature branch (CONTEXT.md → Reactor). Slice boundaries are a **readability** concern, decided by predicted diff size and nameability — *not* a dependency concern. Two Issues can be dependency-independent (both dispatchable now) yet sit in different slices purely for how they read.

## Decision

The stack is **materialized at Open PR time, never in-flight.** Dispatch, review, and merge are completely unchanged: all worktrees branch off the single PRD feature branch and merge back into it. Slices live only as `slice:` frontmatter until the human presses Open PR on the `done` PRD; Open PR then cuts a per-slice branch from the feature branch's merge-commit history in slice-number order (slice N's branch = the feature branch truncated at slice N's last Issue-merge commit), pushes each, and chains the PRs (PR-1 → `defaultBase`, PR-N → slice-(N-1)'s branch).

This cut is sound **only because** to-issues verifies the **no-forward-dependency invariant** (every Issue in slice N is `blocked_by:` only Issues in slice ≤ N) before emitting any `slice:` field, falling back to a single PR if it cannot. That invariant guarantees the Issue merge commits land on the feature branch in slice-compatible order, so "truncate at slice N's last merge commit" is a well-defined, ancestry-correct cut.

## Consequences

- **Parallel dispatch is preserved.** In-flight stacking would serialize the slices — slice-2's Issues could not start until slice-1's branch was stable — and would force a false serialization between dependency-independent Issues that happen to sit in different *readability* slices. Materializing at the end keeps the parallel fan-out the Reactor already does; slicing never touches the dispatch engine.
- **The unstable prediction stays cheap to revise.** Slices are *predicted* from estimated output before any code exists; reality drifts (an Issue grows, a deviation escalates, an Issue goes to human-review). If branch topology were baked in at dispatch, every drift would be an expensive rebase of a live stack. Materializing from completed history means drift only changes *where the cut falls* on an already-finished branch — a re-cut, not a rebase.
- **No live-stack rebase churn.** In-flight, a review fix on slice-1 would force every slice above it to rebase, multiplied across N agents. At Open PR the lower slices are frozen, so the chain is cut once, clean.
- **The common case is literally untouched.** Absent or single `slice:` takes exactly today's single-PR Open PR path — the stack code is purely additive, gated on ≥2 distinct slices. A PRD that does not slice carries zero new risk.
- **Out of scope: incremental review.** Because materialization waits for the whole PRD to be `done`, humans cannot review slice-1's PR while slice-3 is still being built. That is accepted — the readability win is a post-hoc presentation of completed work, and incremental review would re-introduce exactly the live-stack coupling this decision avoids.
- **Rejected: in-flight stacking.** It buys incremental review at the cost of serializing parallel work, coupling an unstable prediction to branch topology, and live-stack rebase churn — three real costs against one speculative benefit, for a feature whose entire purpose is presentation, not pipeline behaviour.
