# The reactor-activity signal is a board-level overlay derived from in-memory state

## Status

accepted

## Context

The Reactor was deliberately *visually invisible* (CONTEXT.md → Reactor →
Visibility): the live board told the story through cards moving on their own. The
`⊘ suppressed` per-card marker ([ADR 0011](./0011-suppressed-overlay-sources-from-in-memory-reactor-state.md))
was the first crack in that — it surfaced one finer Reactor state, a card the
failed-set is silently ignoring. But a per-card marker can't answer a
*board-level* question the dogfooding surfaced: **is the Reactor doing anything
at all?**

The existing auto-run on/off indicator ([ADR 0007](./0007-auto-run-toggle-is-ephemeral.md))
is close but not it. It distinguishes *braked* (off) from *running* (on), yet an
on-Reactor with nothing eligible leaves the board exactly as still as a busy one
that just finished a wave — and as still as an off one. So "the board isn't
moving" collapses three different situations into one: the brake is on, the
Reactor is mid-wave, or there's genuinely nothing to do. An operator watching a
dispatched PRD can't tell which.

The two cases the "surface reactor state" Issue named were (1) the orphan
re-dispatch that fails to launch — already covered by ADR 0011's failed-set + marker
once the rolled-back orphan re-enters the spawn edge and that relaunch throws (it
lands in the same `(Issue, edge)` failed-set as any launch failure), so it needed
a *regression test* pinning the path, not new code — and (2) this board-level
idle / working / at-rest signal, which did.

## Decision

Add a third surfaced signal: a board-level **reactor-activity** overlay —
`working` / `idle` / `at-rest` — on the status line beside the auto-run
indicator, **derived purely from in-memory Reactor state**, never written to the
watched root (ADR 0002):

- **at-rest** — auto-run is off. The Reactor will spawn nothing until re-enabled;
  the stillness is expected. Unconditional on the off state, even if the last
  (enabled) reconcile had spawned.
- **working** — auto-run on *and* the most recent reconcile attempted at least
  one spawn.
- **idle** — auto-run on *and* the most recent reconcile spawned nothing.

The derivation (`deriveActivity`) is a pure total function over two booleans —
`{ enabled, spawnedLastReconcile }` — so it is unit-tested in isolation, the same
shape as the suppressed/liveness marker derivations. The Reactor owns the two
inputs: `enabled` it already held; `spawnedLastReconcile` it now tallies by
wrapping `deps.spawn` for the duration of each reconcile and recording whether any
candidate reached the spawn tip. It exposes the result through an `activity()`
read on the `Reactor` interface, the in-memory analogue of the suppressed
overlay's `suppressedSeam` read.

A spawn that reaches the tip but then *throws* (a failed launch) still counts as
**working**: the Reactor found eligible work and acted, and the *failure* is
already surfaced per-card by the suppressed marker — so working/idle stays a clean
"did it find work to do" signal, not a success/failure verdict.

The UI owns the signal as a single piece of state in `LiveApp`, re-read from
`reactor.activity()` on each of its two drivers: a post-rebuild reconcile (the
live loop fires an `onReconciled` callback after `reconcile()`, so the read sees
the fresh tally) and the auto-run toggle (which flips the Reactor with no
filesystem event, so the indicator would otherwise lag a board rebuild behind).

## Considered Options

- **Fold it into the auto-run indicator** (e.g. a third "auto-run on (idle)"
  string). Rejected: it conflates two orthogonal axes — *is the brake released?*
  and *is the Reactor moving?* — onto one element. Keeping them distinct lets each
  read independently and matches the user-facing vocabulary ("auto-run" for the
  brake, "working/idle" for motion).
- **Derive activity from the board model** (e.g. "any card in-progress ⇒
  working"). Rejected: an in-progress card means *an agent is running*, which is
  liveness, not Reactor activity — a board full of agents the Reactor spawned an
  hour ago and is now idle over would read "working" forever. Activity is about
  the *Reactor's* most recent action, which only the Reactor knows.
- **Persist the signal / track a spawn history.** Rejected for the same reason
  auto-run and the failed-set are ephemeral (ADR 0007): it is live session state,
  recomputed each run, not config. A "last reconcile" tally needs no history.

## Consequences

- **The board gains a second in-memory-sourced overlay.** Like the suppressed
  overlay (ADR 0011), it reaches into the live Reactor rather than reading a file
  — recorded here so a future reader doesn't "fix" it toward a sidecar. The read
  is total (a fresh on-Reactor reads `idle`; an absent Reactor in board-only tests
  leaves the indicator empty), so it never crashes the board rebuild.
- **"Working" is eligibility-found, not success.** Because a failed launch counts
  as working (the failure shows per-card), the signal answers *"is the Reactor
  finding work?"* not *"is every spawn succeeding?"*. The two questions have two
  surfaces — the activity line and the suppressed marker — by design.
- **One-render-tick currency on the toggle.** The auto-run toggle re-reads
  `activity()` synchronously in the same updater that flips the Reactor, so the
  indicator never trails the brake. The reconcile path reads it via the live
  loop's `onReconciled` callback in the same tick the board rebuilds, so neither
  driver leaves the signal stale.
- **The orphan-redispatch-fails case shipped as a test, not new code.** It was
  already covered by ADR 0011's failed-set the moment the rolled-back orphan
  re-entered the spawn edge; this Issue pinned that path with a regression test so
  a failed recovery can't silently regress to an invisible launch-failed card.
