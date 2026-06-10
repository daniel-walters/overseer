# Auto-run state is held in memory and resets to on each launch

## Status

accepted

## Context

The reactor (ADR 0005) ships global and always-on. We added **auto-run** — a single global switch (keybind `a`) that toggles the reactor off so a user can watch the board live, brake a runaway wave, or step through dispatch by hand with `d`/`r`. The switch needs a home for its on/off state. The obvious-looking choice is to persist it (in `config.toml`, or an external state file) so it is remembered across launches.

## Decision

Auto-run state is held **in memory on the reactor instance only** — a flag set by `setEnabled`, toggled by the `a` keybind — and is **on by default at every launch**. It is not persisted anywhere. Closing the board discards it; reopening starts auto-run on again. Re-enabling (`setEnabled(true)`) immediately reconciles so the board catches up on anything that became eligible while it was off, rather than looking dead until the next filesystem event.

## Consequences

- **Resume stays free.** The reactor's defining property is that it is level-triggered off the files, so closing and reopening the board re-reconciles from disk with no session state to restore (ADR 0005). A persisted toggle would be the *one* piece of mutable state that isn't derived from the PRD/Issue files — reintroducing exactly the session state the read-only/level-triggered model was built to avoid. Keeping auto-run ephemeral preserves that.
- **The motivating uses are inherently live.** "Brake a runaway wave" and "step through manually" are this-session acts, like selection and scroll position — already held in memory, not persisted. Auto-run belongs with them, not with config.
- **On-by-default keeps v1 behavior.** A fresh launch behaves exactly as the always-on reactor did, so the toggle is purely additive; nobody relying on automation has to opt back in.
- **The off state must be visible.** An idle on-reactor and an off-reactor both leave the board still, so an off-switch with no indicator is dangerous (you can't tell a braked board from a finished one). A persistent status-line indicator (`▶ auto-run on` / `⏸ auto-run off`) is therefore part of this decision, not optional polish.
