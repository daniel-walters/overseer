# Agent output is `live`-only because `claude logs` does not outlive the job

## Status

accepted

## Context

The [Agent output](../../CONTEXT.md) feature (`o`) shows an agent's recent terminal
output via `claude logs <handle>`, joined to a card by the handle in the Liveness
sidecar ([ADR 0008](./0008-liveness-via-claude-agents-handle-sidecar.md)). The obvious,
high-value framing is **post-mortem**: read a *finished* or *orphaned* agent's last
output to see why it deviated, stalled, or died — which would gate the keybind on "any
card with a recorded handle," not just `live` ones.

We probed the CLI before deciding and found `claude logs` is **scoped to background
jobs still in the registry**: a handle that has left the registry returns
`No job matching '<handle>'` — *identical* to a never-existent handle, and with **exit
code 0** (the no-job case is not signalled by status). So once an agent exits, its logs
go with it; there is nothing to show post-mortem.

## Decision

Gate `o` on a **`live`** verdict only — the same gate as [Kill](./0010-kill-switch-is-stop-only-on-the-liveness-handle.md)
— the one state where `claude logs` reliably returns real output. Post-mortem viewing of
a dead/orphaned agent is **deliberately not offered**: an Orphan's exit is `R`
(re-dispatch), not view-output. The one residual case is the verdict/sidecar **race** (a
card read `live`, then its agent exited before `o`): `claude logs` then returns its own
`No job matching` message, which we **show verbatim in the modal** rather than suppress —
it is informative ("the agent is gone, press `R`"), and exit-code 0 means we couldn't
distinguish it from real output anyway. A card with *no recorded handle at all* (a sidecar
miss) returns nothing and flashes a status-line notice, exactly as Kill does.

## Consequences

A future reader will reasonably assume post-mortem log viewing is missing by oversight and
try to widen the gate to orphaned/done cards — which would produce empty "No job matching"
modals, not the post-mortems they expect. This ADR records that the narrow gate is forced
by a CLI limitation, not a UX preference. If `claude` ever persists logs beyond a job's
lifetime, this decision should be revisited (the sidecar already retains the handle, so the
join would still work — only the gate would widen).
