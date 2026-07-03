# Agent output refreshes on demand, not a live tail

## Status

accepted

## Context

The [Agent output](../../CONTEXT.md) modal (`o`) shows an agent's recent terminal
output, read once via `claude logs <handle>` and emulated to a coherent screen
([ADR 0023](./0023-agent-output-is-live-only-claude-logs-does-not-outlive-the-job.md),
[ADR 0030](./0030-agent-output-is-emulated-to-a-screen-not-shown-as-is.md)). The
snapshot was **frozen for the modal's lifetime**, and the only way to see newer output
was to close and re-open (`o`, `o`). The obvious, high-value framing is a **live tail**:
keep the modal open and let it follow the agent's output as it runs, so a human can
*watch* progress without repeatedly re-opening.

Two substrate facts, both verified before deciding, make a true tail impossible and a
merely-continuous one poor value:

- **`claude logs` is one-shot.** Its usage is `claude logs <id>` — "Print the background
  session's recent terminal output." There is **no `--follow`/`-f`/stream mode** (the
  streaming flags in `claude --help` belong to `--print`/`--output-format=stream-json`, a
  different mechanism). The only way to obtain newer output is to run the command *again*.
- **The substrate repaints, it does not append.** The bytes `claude logs` prints are a
  TTY replay of Claude Code's own full-screen alt-screen TUI (ADR 0030) — a fixed grid
  repainted in place, not a log that grows at the bottom. So there are no "new lines to
  tail"; the *whole screen* mutates, and each refresh is a fresh full-screen emulation.

So the only mechanism available is **re-poll `claude logs` + re-emulate the whole screen**.
Doing that on a timer (auto-refresh) carries real cost: it forces the deliberately
synchronous `claude logs` seam (ADR 0030 — accepted ~0.5s pause on an infrequent keypress)
to become async so a tick can't block the Ink event loop, and it demands an answer to the
scroll-vs-follow conflict — because each refresh replaces the *whole* screen (no stable
line to anchor to), a user who scrolled up to read something gets yanked away on the next
tick. Against that cost the benefit is narrow: a **hung** agent looks identical whether the
view is frozen or live, so "live" only helps someone *watching a working agent progress
hands-free* — a thin slice of the "what is it doing, is it hung?" question the feature
exists to answer.

## Decision

Do **not** build an auto-updating live view. Instead add a **manual, on-demand refresh**:
a single **`r`** keypress inside the open modal that re-runs the *same* read the open did
(resolve handle → `claude logs <handle>` → emulate to a screen) and **replaces** the
displayed screen with the current one, resetting scroll to the top. Between keypresses the
snapshot stays frozen — ADR 0030's frozen-snapshot contract is **preserved**, not reversed;
`r` simply replaces the old close-and-reopen refresh gesture with one in-place keypress.

Because a refresh is the same deliberate, infrequent keypress the open already is, it
**reuses the open path verbatim** — the synchronous `claude logs` read (same accepted ~0.5s
pause) plus the existing async `@xterm/headless` re-emulate — so **no seam is made async**
and no new subprocess-lifecycle or timer is introduced. The edge cases fall out of that
reuse: an agent that **exited** between reads surfaces `claude logs`' verbatim
`No job matching` message (informative — "it finished"), exactly as the open race already
does (ADR 0023); a genuinely **failed** read (10s timeout, buffer overflow, emulator reject)
replaces the screen with the same legible placeholder rather than preserving the prior one
— press `r` to retry. The placeholder wording moves from "close and press `o` again" to
"press `r`" to match the new in-modal gesture.

Auto-refresh is not foreclosed: it is precisely "press `r` for you on a timer," a strict
superset this decision can grow into if manual refresh proves insufficient — at which point
the async-seam and scroll-follow costs above must be paid deliberately.

## Consequences

A future reader will reasonably assume a live tail is missing by oversight and try to add
`claude logs -f` or a refresh timer. This ADR records that the narrow gate is forced by the
CLI (no follow mode) and the substrate (a repainting screen has nothing to append/tail), not
by a UX preference — and that manual refresh was chosen over auto-refresh because auto's cost
(async seam + scroll-vs-follow) exceeds its benefit while a hung agent reads identically
either way. It supersedes ADR 0030's "close-and-reopen is the refresh" line: the refresh is
now the in-modal `r`. This is the on-demand sibling of ADR 0023/0030's constraint-driven
narrowings of the same feature: each records a non-obvious choice the `claude logs` substrate
forces.
