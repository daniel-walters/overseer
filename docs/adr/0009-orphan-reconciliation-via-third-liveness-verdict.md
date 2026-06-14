# Orphan reconciliation is a third liveness verdict plus a human-triggered rollback

## Status

accepted

## Context

[ADR 0008](./0008-liveness-via-claude-agents-handle-sidecar.md) made an
`in-progress` Issue *truthful* about whether its agent is alive (`live` /
`unknown`), and named **orphan reconciliation** as the second of its three
layered features. An **orphan** is an Issue stuck in an *active* status
(`in-progress` / `in-review`) on disk whose agent is gone — it crashed, was
killed, or the board died after the status flip — so no agent will ever write
the next status and the Issue is stuck forever. `dispatch.ts`'s flip-with-rollback
only covers a spawn that *throws at launch*; this covers a worker that dies
*after* launch. Without recovery, every dogfood-session crash forces hand-editing
frontmatter, breaking ADR 0002's "resume is free" promise.

The shipped `unknown` verdict already covers part of this, but it conflates three
cases: a true orphan; a previous-session Issue that legitimately finished (its
on-disk status is no longer active, so it self-resolves); and a **transient
`claude agents --json` failure**, where `createLivenessProbe` degrades *every*
recorded Issue to an empty live set at once. Acting on `unknown` directly would,
on a single 3-second query timeout, flag every running agent as dead.

## Decision

**Detection is a third liveness verdict, computed in the same probe.** The
verdict type grows `live | unknown` → `live | unknown | orphaned`. To compute it
safely the probe must distinguish *why* a handle is absent: a **failed or
non-array `claude agents --json` result** is *degraded* (Claude can't be trusted
⇒ every active card stays `unknown`); only a **cleanly-parsed array** (even an
empty one — Claude is up and reports no live agents) licenses `orphaned`. So the
probe stops blindly returning `[]` on query trouble and instead signals
degraded-vs-clean. This is a deliberate refinement of ADR 0008's "degrade to
all-unknown on any trouble": a false `orphaned` is worse than a false `unknown`,
because it invites a re-dispatch that could double-spawn a still-live agent.

**The active-status gate stays in the scanner, not the probe.** The probe stays
status-ignorant and emits a *trust-qualified absence* (`live` / `absent-clean` /
`absent-degraded`); the scanner — already the only place that stamps liveness on
active-status cards — maps `absent-clean` on an active card to `orphaned`,
everything else to `unknown`. This keeps `computeLiveness` a pure handle-join and
keeps lane knowledge in the model.

**Recovery is human-triggered rollback, never automatic.** A new Issue-level
keybind **`R`** (with a confirmation preview, mirroring `d`/`r`) rolls the
orphan's active status back to its awaiting value (`in-progress →
ready-for-agent`, `in-review → ready-for-review`) — the *same* transition
`dispatch.ts`'s launch-failure rollback already writes, just human-triggered. It
does **not** spawn; the normal spawn edge (the reactor if auto-run is on, `d`/`r`
if off) re-picks the Issue up. The reactor never auto-rolls-back an orphan: the
human is the safety check against a false-dead verdict (a query hiccup, or an
agent that merely *looks* gone while still working).

## Considered Options

- **Auto-reconcile (reactor rolls orphans back itself).** Rejected: a false-dead
  verdict (degraded query, or a live-but-quiet agent) would have the reactor spawn
  a *second* implementor on an Issue whose first agent is still running. The
  flip-before-spawn lock prevents double-spawn within a reconcile, but not against
  a wrong liveness signal. A human in the loop is the cheap insurance.
- **Push Issue status into the probe** so it emits the final `orphaned` verdict
  directly. Rejected: it couples the pure handle-join to the lane model; the
  scanner already gates on active status.
- **A separate detection pass** beside the probe. Rejected: it is the same
  query+join — a sharper verdict, not a second mechanism.

## Consequences

- **A re-dispatch whose spawn then fails to launch is invisible** — it lands as a
  suppressed `ready-*` card via the existing session failed-set. Deliberately left
  to the "Surface reactor state" idea (`docs/ideas.md`), not solved here, because
  it is a *general* spawn-failure-visibility gap, not specific to orphans.
- **The inverse orphan shape — a live agent with no recorded sidecar entry** (a
  crash in ADR 0008's `flip → spawn → record` window) — is out of scope. It can't
  use this Issue-anchored join: recovering *which* Issue a stray agent serves needs
  the `cwd`/worktree correlation ADR 0008 rejected as ambiguous, so it yields at
  best a board-level warning, not a per-card marker + `R`. It is also rare
  (`spawnWithFlip` records synchronously right after spawn, so the window is a
  sub-millisecond hard-crash gap). Named in `docs/ideas.md` as consciously
  deferred.
- **The kill switch (feature #3) still builds on the same seam** — the captured
  handle and the `state` field — unchanged by this ADR.
