# The Linked PR overlay is stack-aware: an aggregate over the stack's PRs

## Status

accepted

## Context

The **Linked PR** overlay (ADR 0013, CONTEXT.md) surfaces whether a `done` PRD has a GitHub PR and its state, as a live `gh` query with a **three-state** card marker: *no PR* / *PR open* / *PR merged*. It was designed around the assumption that a `done` PRD has **one** PR — it queries `gh pr list --head <derived-feature-branch>` and reads the single returned state.

Stacked PRs (ADR 0024) break that assumption. When **Open PR** materializes a stack, a `done` PRD has **N PRs**, one per [Slice](../../CONTEXT.md), each on its own slice branch in its own state — slice-1 merged, slice-2 open, slice-3 open. The single-head query finds at most one of them, and "merged" on the bottom PR would falsely read as "the whole PRD landed" while the upper slices are still open. The overlay must become stack-aware or it lies about completion — and completion is the one state ADR 0013 went to the live-query length precisely to keep honest.

## Decision

When the PRD's Issues carry **≥2 distinct `slice:` values**, the Linked PR overlay queries **all** the stack's slice branches and rolls their states into an **aggregate `N/M merged`** signal, where M is the slice count and N the number merged. The PRD reads as fully landed only when **N = M** (the top slice merged); any `0 < N < M` reads as a stack in progress, never as done. The existing single-PR three-state marker is exactly the **M = 1** case of this aggregate, so the no-stack path is unchanged. `go to PR` opens the **bottom** PR — the stack's entry point, the one a human merges first.

The overlay stays a **live query that stores nothing** (ADR 0013): slice branch names are derived from the same `slice:` fields and the feature-branch scheme, so the identity each query needs is always reconstructable with no stored state. The query stays behind the bounded `PrSeam`, gated to `done` PRDs.

## Consequences

- **Completion stays honest under stacking.** A half-merged stack reads as in-progress, not done — preserving ADR 0013's core property (the *merged* end-of-lifecycle signal is true) in the new N-PR world. The aggregate is the only shape that keeps "the work fully landed" correct when there is more than one PR.
- **The no-stack path is a strict special case.** M = 1 collapses the aggregate back to the original three-state marker, so a PRD that did not slice renders and behaves exactly as before ADR 0024. No branching in the read model beyond "how many slices."
- **The query cost scales with slice count, not PRD count.** A stacked `done` PRD now issues up to M `gh` queries instead of one (or one `gh pr list` filtered across the slice branches). Bounded behind `PrSeam` and gated to `done` PRDs, the cost is proportional to finished, *stacked* work — the rare case — not the whole board. Recorded so a future reader does not collapse it back to a single-head query and re-break the half-merged state.
- **Still no stored state, still ADR 0003-safe.** Nothing lands in `prd.md` or a sidecar; the aggregate is derived live from `slice:` (which Issues carry, not the PRD) plus the live `gh` states. The read-only viewer contract (ADR 0002) holds — the overlay reads GitHub, never the watched root.
- **`go to PR` picks the bottom deliberately.** With a chain of PRs, the entry point a human acts on is slice-1 (merged first, then GitHub retargets the rest). Opening the bottom matches the merge order the PR-body metadata (ADR 0024) instructs, rather than dropping the human into an upper PR whose base is not yet `main`.
