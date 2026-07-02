# Agent output is emulated to a screen, not shown as-is

## Status

accepted

## Context

The [Agent output](../../CONTEXT.md) modal (`o`) shows an agent's recent terminal output
via `claude logs <handle>` ([ADR 0023](./0023-agent-output-is-live-only-claude-logs-does-not-outlive-the-job.md)).
CONTEXT.md recorded that the output was shown **as-is** — "ANSI passes through; sanitizing
control sequences is deferred" — splitting the raw stdout on `\n` and rendering the slices
in a fixed-width Ink `<Text>`.

That deferral proved unusable. `claude logs` has **no plain-text mode** (verified: it only
"prints the background session's recent terminal output"), and the agent it replays **is
Claude Code itself** — a full-screen alt-screen TUI. So the captured bytes are a **TTY
replay**: carriage-return in-place redraws, cursor-up/absolute-position escapes, erase
sequences, spinner frames, box-drawing rules — authored for a terminal that repaints a
fixed grid in place. Splitting that on `\n` and dropping it into a Yoga-laid-out box makes
the cursor-movement escapes fight the box layout, producing overlapping, interleaved,
unreadable output.

Two cheaper fixes were rejected. **Strip-ANSI-only** keeps byte order, so with Claude
Code's cursor-up redraws it concatenates every frame — stacked "Metamorphosing…" lines,
half-drawn boxes; it trades overlap for duplication. A **linear transcript** over-promises:
`claude logs` returns a bounded *recent* snapshot, and a TUI replay has no meaningful linear
history to recover.

## Decision

Run the captured bytes through a headless terminal emulator (`@xterm/headless`) that
maintains a cols×rows grid, let the redraws resolve against it, and read the **final screen
state** back as clean lines — reconstructing *what the agent's terminal looks like now*,
which is the present-tense question the observation feature exists to answer.

The transform is a single pure module (`renderTerminal(rawBytes, cols, rows) → string[]`)
that owns the `@xterm/headless` dependency; nothing else imports the emulator. The
**data reader stays raw** (returns `claude logs` bytes verbatim) and the **modal stays a
presenter** (renders supplied `lines`); `App` — which owns layout dimensions and already
passes pre-split `lines` to the modal — runs the transform, sized to the modal's inner
width. The grid width is the modal's width (the stream carries no reliable original width;
imperfect wrapping for foreign-width content is accepted).

`@xterm/headless.write()` flushes on a callback, so the resolved buffer must be awaited.
The `o`-open path therefore becomes **asynchronous**, revising the "synchronous seam"
framing of ADR 0023 for this one read. The frozen-snapshot contract, `scrollDetail`
windowing, the `(no output yet)` placeholder, the verbatim "No job matching" surfacing,
and the reader's failure/timeout placeholders are all unchanged. (The "close-and-reopen is
the refresh" gesture noted here is later superseded by the in-modal `r` refresh —
[ADR 0031](./0031-agent-output-refreshes-on-demand-not-a-live-tail.md) — which keeps the
frozen-snapshot contract but replaces the refresh gesture.)

## Consequences

A new runtime dependency (`@xterm/headless`) enters the tree solely to emulate agent
output, and the previously-synchronous `o` read becomes async — a maintainer expecting the
ADR-0023 synchronous seam will find this deliberate, recorded here. If someone later wants
the read synchronous again, the fallback is a hand-rolled synchronous VT parser, which
trades the mature library for error-prone emulation code — a trade this decision declines.
This is the terminal-emulation sibling of [ADR 0014](./0014-detail-body-rendered-through-marked-terminal.md):
both transform terminal-oriented bytes before they reach an Ink box, one via markdown,
one via VT emulation.
