# Agent liveness comes from `claude agents --json`, joined by a captured `--bg` handle in a sidecar

## Status

accepted

## Context

Overseer launches agents with `claude --bg` and then goes blind: the board reads
only the agents' *footprints in the Issue files*, never the processes (ADR 0002).
So an `in-progress` Issue is ambiguous — working, hung, or dead, with no way to
tell. Making `in-progress` *truthful* (the [Liveness](../../CONTEXT.md) overlay)
is the minimum bar to confidently dogfood Overseer on itself (`docs/ideas.md` →
"High priority"). It is the first of three layered features; #2 (orphan
reconciliation) and #3 (kill switch) build on the same seam.

Liveness needs two things: a **source of truth** for "is this agent alive?" and a
**join key** from a live process back to an Overseer Issue. Several options were
weighed:

- **OS PID + start-time.** Reverse-engineers liveness from the OS and must defeat
  PID recycling itself (a recycled PID with a matching start-time is the failure
  mode). Works, but re-derives what Claude already knows.
- **`claude agents --json`.** Claude owns the `--bg` session lifecycle and reports
  it directly: a JSON array of live sessions, each with `id`, `cwd`, `startedAt`,
  `sessionId`, and a `status`/`state` field. The authority on liveness, no
  recycling guesswork — a recycled PID is simply never listed.

For the **join key**, given `claude agents --json` as the source:

- **`sessionId` pinned via `--session-id`.** Rejected: `--bg` prints
  `warning: --bg manages the session id; ignoring --session-id`. A caller cannot
  pin a background session's id, so Overseer cannot know it in advance.
- **`cwd`.** Ambiguous by construction here: implementors fan out into worktrees
  with **random** names (ADR 0006), and at spawn time every implementor in one
  repo shares the same `cwd` (the repo root — the worktree doesn't exist yet). It
  cannot distinguish two Issues dispatched into the same repo in one wave, which
  is the *normal* case for a wide PRD under the reactor.
- **The handle `--bg` prints at launch.** `claude --bg` emits
  `backgrounded · <handle>` on stdout; that same handle appears as the `id` field
  of the session's row in `claude agents --json`. Unique per spawn, Claude-owned,
  unambiguous.

`--bg` exposes no structured launch output: `--output-format json` is documented
as "only works with `--print`" and is ignored under `--bg`, so the handle is only
available by parsing the human-facing `backgrounded · <handle>` line.

## Decision

Liveness is read from **`claude agents --json`**, joined to Issues by the
**handle Overseer captures from `--bg`'s launch stdout**, persisted in a
**sidecar state file outside the watched root** (`~/.local/state/overseer/`,
beside `dispatch.log`).

The spawn edge changes from fire-and-forget to launch-and-remember:

1. **Flip** the awaiting status to active (`ready-for-agent → in-progress`)
   *before* spawn — unchanged; the flip is still the idempotency lock (ADR 0002).
2. **Spawn** `claude --bg …`, capturing stdout, and parse the
   `backgrounded · <handle>` line. This requires the `ExecSeam` to **return
   stdout** rather than its current `=> void`.
3. **Record** `{ issueKey → handle }` in the sidecar.

An Issue is **live** iff its recorded handle is present as a row `id` in
`claude agents --json` (and the row's `state`/`status` further says
busy/blocked/idle). Absent → **not live**. On a fresh board open Overseer
re-queries and re-intersects; nothing about liveness lives in the Issue files, so
the viewer stays read-only and resume stays free.

The handle is recorded **after** spawn returns (the handle does not exist until
then), so the edge is necessarily flip → spawn → record. A crash in that window
leaves a live-but-unrecorded agent — deliberately left to orphan reconciliation
(feature #2: a `claude agents --json` row whose handle matches no sidecar entry,
under a known repo). The two `status`/`state` shapes (interactive rows use
`status`, background rows use `state`) must both be handled when parsing the JSON.

## Consequences

- **The PID is never persisted; Claude owns identity end-to-end.** The sidecar
  holds only `issueKey → handle`. No PID-recycling defeat to implement, no
  start-time bookkeeping. Couples Overseer to `claude agents`' registry and to the
  `backgrounded · <handle>` stdout format — the same coupling ADR 0006 already
  named and accepted.
- **`ExecSeam` becomes `=> string` (stdout); the change ripples through
  `dispatch.ts`'s flip-spawn orchestration.** This is the architectural seam where
  "launch and forget" becomes "launch and remember" — the point of the feature,
  not incidental damage.
- **Liveness degrades to "live / unknown," never a false "live."** A handle absent
  from the live set reads as not-live; an agent from a previous session Overseer
  never recorded reads as unknown. #1 deliberately stops there; #2 picks up the
  unknowns.
- **The kill switch (#3) comes nearly free.** The same captured handle is what
  `claude stop <handle>` takes, and the `state` field starts answering "is it
  hung?" — so one stdout parse pays down three of the theme's gaps.
- **Parsing human-facing stdout is brittle.** There is no structured `--bg` launch
  output today; if Claude changes the `backgrounded · …` line the parse breaks.
  Accepted for now, revisit if a structured launch surface appears.
