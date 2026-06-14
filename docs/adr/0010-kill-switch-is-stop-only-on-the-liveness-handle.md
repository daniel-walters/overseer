# The kill switch is a stop-only `claude stop` on the liveness handle, recovered by the existing orphan flow

## Status

accepted

## Context

[ADR 0008](./0008-liveness-via-claude-agents-handle-sidecar.md) named the **kill
switch** as the third of its three layered features and predicted it would come
"nearly free": the captured `--bg` handle in the sidecar is what a termination
command takes. This ADR makes that real. It is the last piece of the
dogfood-minimum set (`docs/ideas.md` → "High priority"): auto-run's `a` toggle
stops the Reactor *spawning new* agents, but the ones already running keep
running — there is no way to stop one in-flight agent. The kill switch is that
"true pause," made actionable.

ADR 0008 assumed a `claude stop <handle>` command; it exists (hidden from the
top-level help, but `claude stop <id>` stops a background session). All three
links in the chain were verified end-to-end against a throwaway `--bg` agent: the
launch prints `backgrounded · <handle>`; that handle appears as the **`id`** field
of the session's **`kind: "background"`** row in `claude agents --json` (an
interactive row carries no `id`, only `sessionId` — but Overseer only ever spawns
`--bg`, so it only ever joins background rows, and the shipped `record.id` join is
correct); background rows carry `state` where interactive rows carry `status`
(both normalised by `parseLiveSet`); and `claude stop <handle>` **drops that row
from the live set**, so the killed agent's handle goes absent and the card flips
`live → orphaned` on the next scan. Critically, **`claude stop` keeps the
session** (resumable via `claude attach`) — it is a *suspend*, not a destroy. So a killed agent leaves its Issue exactly in the shape of an
**Orphan**: an active-status Issue (`in-progress` / `in-review`) whose agent is
no longer running. Orphan reconciliation ([ADR 0009](./0009-orphan-reconciliation-via-third-liveness-verdict.md))
already ships the recovery half — the `R` rollback — so the kill switch only
needs to add the *stop*, not a new recovery path.

## Decision

**Kill is stop-only.** A new Issue-level keybind **`K`** (shift, like `R` — a
rare, heavy action, distinct from `k` move-up), gated on a `live` liveness
verdict, runs `claude stop <handle>` against the handle the sidecar recorded at
spawn. It writes **nothing** to the Issue file. The Issue stays in its active
status, off the Reactor's frontiers, so the Reactor cannot re-spawn it — a
**durable pause of one in-flight agent**. On the next scan the stopped agent's
handle is absent from `claude agents --json`, so the card flips `live → orphaned`
and the existing `R` flow recovers it (`in-progress → ready-for-agent`); under
auto-run, that re-arm restarts the agent. Kill stops; `R` recovers; the two
verbs stay separate.

**Confirm fires the frozen handle; it does not re-query liveness.** `K` opens a
confirmation preview (mirroring `d`/`r`/`R`) that freezes the handle read from
the sidecar at preview-open. Confirm calls `claude stop` on that frozen handle
and reports the outcome. There is no disk re-read and no `vanished` outcome.

**`claude stop`'s outcome needs the stderr, not just the exit code.** Empirically
`claude stop` has three *ran-and-exited* result shapes, not two — the exit code
alone cannot separate the last two — plus a fourth *never-ran* shape when the
binary itself is missing:

| `claude stop` prints | exit | `KillOutcome` |
| --- | --- | --- |
| (clean success) | 0 | `stopped` |
| `No job matching '<id>'…` | ≠0 | `not-running` |
| `couldn't confirm <id> was stopped — … Try again` | ≠0 | `uncertain` |
| (never launched — `ENOENT`) | — | `unavailable` |

So the `StopSeam` returns the exit status, stderr, *and* a `spawnFailed` flag, and
the killer maps `spawnFailed` → `unavailable`, exit 0 → `stopped`, a non-zero whose
stderr matches `No job matching '<id>'` **for the handle we stopped** →
`not-running`, and **any other non-zero → `uncertain`**.

Two refinements keep `not-running` from being a *false* "nothing to stop": the
`No job matching` match is **anchored to the stopped handle** (a stale line about
another agent, or a reworded message that drops the id, stays `uncertain` rather
than collapsing to a confident "already gone"); and `ENOENT` (claude not on PATH)
gets its own `unavailable` verdict instead of hiding in `uncertain`, because a
missing binary is a config error to fix, not a transient "try again". Collapsing
"couldn't confirm" into "wasn't running" (as an exit-code-only model would) is
wrong: telling the human "nothing to stop" when the stop is actually in-flight is a
false negative. The notices are: `stopped` → "Stopped <id>'s agent — recover it
with R."; `not-running` → "<id>'s agent is no longer running — nothing to stop.";
`uncertain` → "Couldn't confirm <id> stopped — re-check the board."; `unavailable`
→ "Couldn't run `claude stop` — is the claude CLI on your PATH?". The board's next
scan is the source of truth regardless (the stopped agent's row drops from `claude
agents --json`, flipping the card to `orphaned`), so `uncertain` only sets honest
expectations — it never has to be authoritative.

**The kill never touches the sidecar.** It reads the handle to freeze it; the
entry is left in place. A re-dispatch overwrites it on the next spawn (the same
contract `R`'s rollback already relies on). Deleting it would strip the handle
the `orphaned` verdict needs, breaking `R`.

The seam is a standalone `Killer` (`readKill` → `KillPreview`, `kill` →
`KillOutcome`), a sibling of the `Rollback`/`Reviewer` seams, parameterised over
the sidecar, with the `claude stop` subprocess behind its own injectable
`StopSeam` — one seam per external edge, exactly as spawn and the liveness probe
each have.

## Considered Options

- **Kill also rolls the Issue back (or routes it to `human-review`).** Rejected.
  Routing to `human-review` resurrects the rejected rework path — that queue is
  for *work that needs judgment*, not a halted launch (CONTEXT.md → Review
  outcome). Auto-rolling-back fuses two decisions the human should make
  separately (stop now; decide whether to re-dispatch later) and re-spawns work
  the human may want to inspect first. Stop-only leans on the *already-shipped*
  `R` for recovery, which is why the kill switch is genuinely small.
- **Re-query liveness at confirm (mirroring `R`'s re-read-disk discipline).**
  Rejected. `R` re-reads disk because acting on a stale verdict would *destroy*
  legitimately-advanced work; a stale-`live` `K` just sends `claude stop` to an
  already-gone session, which `claude stop` absorbs as a harmless non-zero-exit
  no-op. A second subprocess call on the keypress path to defend a harmless
  outcome is not worth it; the exit code already yields the human-legible
  "nothing to stop" notice.
- **Delete the sidecar entry on kill.** Rejected — it strips the recorded handle
  the `orphaned` verdict (and thus `R`) depends on, making the killed card
  un-recoverable.
- **An OS-signal kill by PID.** Considered when `claude stop` was thought not to
  exist; moot once it was confirmed. It would have re-introduced the PID and
  PID-recycling risk ADR 0008 deliberately designed out — `claude stop`'s
  handle-based termination keeps Claude the owner of process identity end-to-end.

## Consequences

- **You can only kill what Overseer recorded.** A `live` verdict requires a
  recorded handle, so an agent from a previous session or one spawned outside
  Overseer reads as no-marker/`unknown` and cannot be killed from the board.
  Accepted for v1 — consistent with liveness being a recorded-handle overlay.
- **A stopped-but-lingering session reads `live`.** If `claude stop` leaves the
  row in `claude agents --json` until it ages out, the card stays `live` (so `R`
  does not light) until the row drops — the *same* "lingering exited row reads
  live" limit ADR 0009 already documents and accepts (membership is id-only). The
  kill inherits it; it does not re-solve it. If real runs show stopped rows
  linger, reading `state` to call them dead is the deferred "is it hung?"
  iteration, tracked separately.
- **Kill is a suspend, not a destroy.** `claude stop` keeps the conversation
  (`claude attach` resumes it). Overseer treats the agent as gone for board
  purposes (it orphans), but the underlying session is recoverable outside
  Overseer. Naming it "kill" in the keybind overstates the finality slightly;
  CONTEXT.md records the suspend semantics.
- **Under auto-run, recover restarts.** `K` alone is the durable stop (the Issue
  parks off-frontier); pressing `R` re-arms it, and with auto-run on the Reactor
  immediately re-spawns. "Kill permanently" means kill and *don't* `R` (or toggle
  auto-run off first). This is the existing frontier model, not new behaviour.
- **`K` is a second hardcoded keybind copy.** It lands in both the `App` input
  handler and the `HelpModal` `BINDINGS` list, guarded against drift by the
  existing "lists every implemented keybind" test — until the central keybind
  registry (`docs/ideas.md`) lands.
