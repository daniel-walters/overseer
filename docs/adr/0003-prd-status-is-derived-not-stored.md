# PRD status is derived at read time, not stored

## Status

accepted

## Context

A PRD is rendered as a card on the board-level kanban, so it needs a column.
Early framing (see CONTEXT.md history) gave a PRD its own authored `status`
frontmatter field, using the **same 5-value vocabulary as an Issue** (including
the `ready-for-*` substatus), "maintained by hand/agent on top of the issues,
decoupled from them — NOT derived."

Two problems surfaced:

1. **The vocabularies aren't the same.** The `ready-for-human` /
   `ready-for-agent` distinction is a *routing* signal — "who picks up this unit
   of work." You dispatch an **Issue** to an agent, never a whole PRD. So
   `ready-for-*` (and its 🧑/🤖 badge) is meaningful only at the Issue level. A
   PRD only ever passes through **backlog → in-progress → done**.

2. **An authored PRD status can lie.** With issues carrying the real progress,
   a hand-written PRD `status` drifts: `done` in `prd.md` while issues sit in
   `backlog`. The PRD's true status is already fully determined by its issues.

## Decision

**A PRD has no stored status.** The `status` field is removed from `prd.md`
entirely — `prd.md` carries `title` (and the body) and nothing about status.

The board **derives** a PRD's column at read time, during the same full re-scan
it already performs on every filesystem event:

- there is **≥ 1 issue and every issue is `done`** → **done**
- otherwise, **any issue is `in-progress` or later** (`in-progress`,
  `in-review`, `done`) → **in-progress**
- otherwise (all issues `backlog`/`ready-*`, **or zero issues**) → **backlog**

A freshly created PRD with no issues yet is therefore **backlog** — `done`
requires at least one issue, all done. This avoids the vacuous-truth trap where
an empty issue set reads as "all issues done."

The **board-level kanban collapses to three columns** — backlog / in-progress /
done — plus **Unsorted**. A PRD is never in `ready` or `in-review`; those are
Issue-level-only columns. Because a PRD has no status field, a PRD is **never
Unsorted** — it is always computably one of the three. Unsorted remains an
**Issue-level** concept (an Issue with a missing/unrecognized status).

The 🧑/🤖 `ready-for-*` badge renders at **Issue level only**, not at board
level.

## Consequences

- **The read-only viewer is reaffirmed, not punctured.** Nobody *writes* PRD
  status — not the TUI, not the dispatcher, not the implementor agents. This is
  strictly stronger than [ADR 0002](./0002-agents-write-the-root-viewer-stays-readonly.md):
  Issue status is the shared event bus that agents write; PRD status is a pure
  read-time projection of that bus. The dispatcher's rollup that an earlier
  draft of this decision imagined is unnecessary — there is nothing to roll up.
- **`/to-prd` writes `prd.md` with no `status` field**, only `title` + body.
  The producer skill never seeds or maintains PRD status.
- **The derivation lives in the scan/model layer** (`src/scanner.ts` /
  `src/model.ts`), computed from the PRD's already-scanned issues — not in a
  writer.
- **No write amplification.** Were PRD status stored-and-derived, every issue
  transition would force a rewrite of the parent `prd.md`, multiplying writes
  and re-scan churn. Deriving at read time costs a cheap fold over issues the
  scan has already loaded.
- A future need to expose PRD status to an *external* tool (something that reads
  the root without Overseer's scan) would have to recompute it the same way, or
  reopen this decision to persist a derived value.
