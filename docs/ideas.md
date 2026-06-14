# Ideas & future considerations

A running backlog of feature ideas and considerations for Overseer that aren't yet
committed work. Not the issue tracker — this is the holding pen before an idea is
shaped into a PRD or issues. See `CONTEXT.md` for domain language.

## Theme: Overseer launches agents but doesn't own them

A framing that several ideas below are facets of, worth stating once on its own.

Overseer is a **read-only viewer of files**; agents are **fire-and-forget `claude --bg`
processes** that write the files back (ADR 0002). The board only ever sees the agents'
*footprints in the files* — never the processes themselves. That boundary buys real
simplicity and a free **resume** (close and reopen the board; it re-reconciles whatever
the files now say — there is no session state to restore). But it has one sharp edge,
and it's the edge a user *feels* once the reactor is running: **Overseer can launch an
agent but cannot watch, pause, or kill it.** The moment it spawns, the agent has left
Overseer's world.

So, separating what's solved from what's only wished-for:

- **Manual vs. automatic** — *solved.* One rule: a human ignites a PRD with `d`; the
  reactor is cruise control from there. The **auto-run** toggle (`a`) turns cruise
  control off — global, in-memory, on by default (see `CONTEXT.md` → Auto-run).
- **Resume** — *solved for free*, by level-triggering off the files (above).
- **Live tracking of running agents** — *partially solved.* **Liveness** (shipped,
  [ADR 0008](./adr/0008-liveness-via-claude-agents-handle-sidecar.md)) surfaces
  live/unknown/orphaned per card, so `in-progress` is no longer ambiguous about *whether*
  its agent is running, and **orphan reconciliation** (shipped,
  [ADR 0009](./adr/0009-orphan-reconciliation-via-third-liveness-verdict.md)) recovers a
  card whose agent is gone with one keypress (`R`). Still open: *which* `claude --bg` is
  which beyond the marker, whether one is hung, and its output (see "Per-agent logs"
  below).
- **True pause of in-flight agents** — *solved.* The **kill switch** (shipped,
  [ADR 0010](./adr/0010-kill-switch-is-stop-only-on-the-liveness-handle.md)) `claude stop`s
  one live agent on `K`, parking its Issue off the reactor's frontiers — a durable
  per-agent pause the auto-run toggle could not give. It is stop-only; the shipped `R`
  orphan flow recovers the parked Issue.

The remaining design frontier, when the unease bites, is therefore **not more
automation** — it is giving Overseer a way to *observe* the agents it launches more
richly (which one is hung, what it is printing), without abandoning the
read-only/level-triggered model that makes resume free. That likely means a
process-tracking seam that lives *beside* the file viewer, not inside it. Until then,
live tracking beyond the liveness verdict is a wish (see "Per-agent logs" below).

## Dogfood-minimum: shipped

The minimum set to confidently dogfood Overseer on itself — to build Overseer using
Overseer as the harness — has **shipped**. The bar was never "more features"; it was
**trust**: `in-progress` used to be ambiguous (working? hung? dead?), and the failure
you'd hit while building Overseer was exactly the one the board couldn't show you. Three
layered features, all on one handle sidecar, converted the board from "shows footprints"
to "tells the truth":

- **Liveness** ([ADR 0008](./adr/0008-liveness-via-claude-agents-handle-sidecar.md)) —
  process tracking that survives a board restart (so resume stays free, ADR 0002): each
  card reads live / unknown / orphaned.
- **Orphan reconciliation** ([ADR 0009](./adr/0009-orphan-reconciliation-via-third-liveness-verdict.md))
  — a dead `in-progress` card is recoverable with one keypress (`R`).
- **Kill switch** ([ADR 0010](./adr/0010-kill-switch-is-stop-only-on-the-liveness-handle.md))
  — `K` `claude stop`s one live agent (stop-only), the durable per-agent pause auto-run
  could not give; the parked Issue orphans and `R` recovers it.

What remains below is *beyond* the dogfood minimum — richer observation and convenience,
not trust.

### (Deferred) The inverse orphan: a live agent with no recorded handle

ADR 0008 names a *second* orphan shape — a crash in the `flip → spawn → record` window
leaves an agent **running** (a `claude agents --json` row) whose handle matches **no**
sidecar entry, and an `in-progress` Issue with no recorded handle (so its card shows no
marker, looking like a never-tracked legacy Issue). The danger: a human assumes it's dead
and re-dispatches, double-spawning one Issue. Deliberately **out of scope** for the shipped
orphan reconciliation ([ADR 0009](./adr/0009-orphan-reconciliation-via-third-liveness-verdict.md)):
it can't use the same Issue-anchored join — recovering *which* Issue a stray agent belongs
to needs the `cwd`/worktree correlation ADR 0008 explicitly rejected as ambiguous — so it
yields at best a board-level "N untracked live agents" warning, not the per-card marker +
`R` that ADR 0009 builds. It is also *rare*: `spawnWithFlip` records synchronously
immediately after spawn returns, so the window is only a hard crash (SIGKILL/power loss) in
a sub-millisecond gap, not any normal error path. Named here so it reads as consciously
deferred, not forgotten.

## Ideas

### Per-agent logs from a card *(unlocked by the liveness handle)*

Now that the **Liveness** ([ADR 0008](./adr/0008-liveness-via-claude-agents-handle-sidecar.md))
sidecar records `issueKey → handle`, drilling into a running agent's output is one join
away: select an in-progress / in-review card → `claude logs <handle>` for *that* Issue's
agent. The handle (not the PID) is the key — Claude owns the log plumbing and keys it by
handle, so no extra persistence beyond what liveness already stores.

This is **unlocked by Liveness but a distinct feature**, deliberately kept out of the
liveness PRD (it is in that PRD's Out of Scope). It is more than the one-shot
`claude agents --json` membership test liveness needs:

- **A new capability for a read-only viewer.** Today Overseer spawns (`claude --bg`) and
  reads files; shelling out to `claude logs` to pull/stream output is a different subprocess
  call, and live tailing is more than a single membership query.
- **A TUI rendering problem.** Where do logs render (detail pane? modal?) and how do they
  coexist with the alt-screen board that already *clips* on overflow (see "Viewport
  scrolling" below)? Live log tailing inside Ink is real UI work.
- **Overlaps "is it hung?".** The `state: working/idle/blocked` field liveness already
  captures is the *cheap* signal and may answer "what's it doing" 80% of the time; full
  logs are the *expensive* signal to reach for when `state` isn't enough.

So: a natural follow-on now that the liveness handle has landed, but its own UI-shaped
piece of work, not part of the dogfood-minimum set.

### Pause / resume development of a PRD

A way to pause and later resume development of a PRD. While paused, the dispatcher
should not spawn (or keep spawning) agents for that PRD's issues; resuming picks
development back up. Open questions: where does the pause state live (PRD frontmatter
vs. external state, given Overseer is a read-only viewer of the files), how it surfaces
on the board, and how in-flight agents are handled at the moment of pausing.

### Surface reactor state on the board

The reactor is **visually invisible** in v1 — its only diagnostic surface is the
durable failure log. Two states that look identical to a healthy board but aren't:
(1) a spawn-failed Issue that rolled back to its eligible status and is now
**suppressed** by the session failed-set (looks like a normal `ready-*` card, but the
reactor is deliberately ignoring it); (2) idle vs. actively-working vs. at-rest. A
future UI pass would surface these — e.g. a card marker for spawn-failed/suppressed
Issues (mirroring the `human_review_reason` marker), and/or a board status line. For
now everything goes to the log; we surface in the UI later.

This also catches **orphan re-dispatch that fails to launch**: orphan reconciliation
([ADR 0009](./adr/0009-orphan-reconciliation-via-third-liveness-verdict.md)) rolls an
orphan back to `ready-for-agent` and lets the normal spawn edge re-pick it up, so a
relaunch that throws lands as a suppressed `ready-*` card exactly like any other spawn
failure — invisible by the same mechanism, to be fixed here, not in ADR 0009.

### Configurable AI-review turns and effort

The AI review loop ships with a hardcoded cap of **3** `/code-review` passes at
**medium** effort (see `CONTEXT.md` → Review outcome). Once there are real runs to
calibrate against, promote both to `config.toml` knobs — a per-board (or eventually
per-PRD) iteration cap and effort level — rather than baking the v1 defaults in
forever.

### Viewport scrolling (overflow on the alternate screen)

"Always full screen" (UI Polish part 1) renders the board on the terminal's
**alternate screen buffer** (à la vim/htop), sized to fill the viewport. The alt
buffer has **no scrollback** (standard terminal behaviour — Ink's own docs warn of
it), so when a column has more cards than fit, the overflow is **clipped and
unreachable** — there is no scroll and no scrollback to recover it. This converts an
overflow that used to be merely awkward (scroll the terminal) into genuinely hidden
content on small terminals.

We **knowingly accepted clipping** for part 1 rather than block full-screen on it.
The follow-up is in-app **viewport scrolling / virtualization** within a column (and
possibly horizontal paging across columns) so no card is ever unreachable. Until then,
a small terminal can hide cards with no recourse.

### UI polish follow-ups

Small UI fixes noted against the full-screen board and `?` help modal (UI Polish
part 1):

- **Help modal should be a true modal, not a screen takeover.** It currently
  replaces the board; it should overlay it (board visible/dimmed behind) so opening
  help doesn't lose the user's place.
- **Bottom bar needs spacing between the `auto` indicator and the `?` keybind.**
  They currently render flush against each other; add separation so they read as
  distinct elements.

### Central keybind registry

Keybinds are hardcoded inline as `if (input === "…")` branches in `App.tsx`'s
`useInput`. The `?` help modal (UI Polish part 1) lists them as a **second hardcoded
copy**, guarded against drift only by a test. A future refactor would lift keybinds
into a single `{key, label, level}` registry that *both* the input handler and the
help modal consume, eliminating the drift risk — deferred from part 1 to avoid
dragging an input-architecture refactor into a polish pass.
