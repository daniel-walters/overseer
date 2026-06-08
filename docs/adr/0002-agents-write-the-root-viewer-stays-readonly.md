# Agents and dispatch tooling write the root; the viewer stays read-only

## Status

accepted

## Context

Overseer-the-TUI is a strict read-only viewer of the PRD/Issue files under the
configured root (see CONTEXT.md). Dispatch introduces a second class of actor —
the **dispatcher** (triggered by the board's `d` keybinding) and the
**implementor agents** it spawns — that *writes* those same root files:

- the dispatcher synchronously flips a dispatched Issue's `status`
  `ready-for-agent → in-progress` before spawning its agent;
- the implementor agent flips its Issue `in-progress → in-review` when done.

We deliberately puncture the "files are authored only by hand" framing rather
than route status through a side channel (a database, a state file, GitHub).

## Decision

The read-only invariant applies to **Overseer the rendering process only**. The
status field in the on-disk frontmatter is the **shared event bus** between
agents. Because the root is filesystem-watched, an agent's write triggers a
re-scan and the board live-updates — so dispatching from the board and watching
cards move across columns is the same mechanism, not two.

The actors that may write the root are exactly: the dispatcher, dispatched
implementor agents, and (future) the reviewer agent. Overseer's render loop
never writes.

## Consequences

- **The board is a live mirror of agent progress** with no extra wiring — the
  watcher already in place is the update channel.
- **Idempotency falls out of the status itself.** The frontier is
  `ready-for-agent` only; the dispatcher flips to `in-progress` *before*
  considering the next issue, so a re-dispatch (or a second Overseer instance)
  sees `in-progress` and skips. No external lock needed.
- **Truthfulness is the dispatcher's responsibility.** If a spawn fails after
  the flip, the dispatcher rolls the Issue back to `ready-for-agent` so the
  board never shows in-progress work with no agent behind it.
- **`done` is reserved.** Implementors stop at `in-review`; only the (future)
  reviewer/merge loop sets `done`. Since blockers clear only on `done`, the
  frontier cannot cascade without that loop — dispatch is single-wave today.
- A future writer that does NOT respect these transitions could corrupt the
  board's meaning; the transition rules are the contract, not just convention.
