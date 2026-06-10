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
  reactor is cruise control from there. The toggle (below) turns cruise control off.
- **Resume** — *solved for free*, by level-triggering off the files (above).
- **Live tracking of running agents** — *open gap.* The board shows `in-progress` /
  `in-review` cards, so you can see *that* agents are working — but not *which* `claude
  --bg` is which, whether one is hung, or its output. ("Surface reactor state" below
  gestures at this; it is not yet a design.)
- **True pause of in-flight agents** — *open gap.* Toggling the reactor off (or pausing
  a PRD) stops it spawning *new* agents; the ones already running keep running. There is
  no kill switch. "Pause" today means "stop starting more," not "stop."

The next real design frontier, when the unease bites, is therefore **not more
automation** — it is giving Overseer a way to *observe and rein in* the agents it
launches, without abandoning the read-only/level-triggered model that makes resume free.
That likely means a process-tracking seam that lives *beside* the file viewer, not inside
it. Until then, live tracking and true pause are wishes, not committed solutions.

## Ideas

### Pause / resume development of a PRD

A way to pause and later resume development of a PRD. While paused, the dispatcher
should not spawn (or keep spawning) agents for that PRD's issues; resuming picks
development back up. Open questions: where does the pause state live (PRD frontmatter
vs. external state, given Overseer is a read-only viewer of the files), how it surfaces
on the board, and how in-flight agents are handled at the moment of pausing.

### Toggle the reactor on/off

The reactor (auto-spawn reviewers for `ready-for-review` Issues, and re-dispatch
implementors for Issues whose blockers just went `done`) ships **global and always-on**
in v1 — once a human kicks a PRD off with `d`, the reactor drives it the rest of the
way. A future control would let the user toggle the reactor off (a keybind or board
state) so they can watch the board live without auto-spawning — e.g. to pause a runaway
wave, or to step through dispatch manually with `d`/`r`. Relates to the per-PRD
pause/resume idea above (a global switch vs. per-PRD pause). Open question: off-by-default
vs. on-by-default once toggling exists.

### Surface reactor state on the board

The reactor is **visually invisible** in v1 — its only diagnostic surface is the
durable failure log. Two states that look identical to a healthy board but aren't:
(1) a spawn-failed Issue that rolled back to its eligible status and is now
**suppressed** by the session failed-set (looks like a normal `ready-*` card, but the
reactor is deliberately ignoring it); (2) idle vs. actively-working vs. at-rest. A
future UI pass would surface these — e.g. a card marker for spawn-failed/suppressed
Issues (mirroring the `human_review_reason` marker), and/or a board status line. For
now everything goes to the log; we surface in the UI later.

### Configurable AI-review turns and effort

The AI review loop ships with a hardcoded cap of **3** `/code-review` passes at
**medium** effort (see `CONTEXT.md` → Review outcome). Once there are real runs to
calibrate against, promote both to `config.toml` knobs — a per-board (or eventually
per-PRD) iteration cap and effort level — rather than baking the v1 defaults in
forever.

### Push spawn-failure suppression into the shared spawn edge

The Reactor's failed-set suppression currently sits **around** the shared spawn edge:
`createReactor` subtracts the failed-set before `runDispatch`/`runReview` and records
into it via a `logFailure` wrapper. But `spawnWithFlip` already owns the rollback and
emits the exact `(issue, edge)` `FailureRecord` the set is keyed on — so the
"a level-triggered driver must not re-pick-up a rolled-back spawn" invariant is enforced
by convention at the call site, not by the edge. The next automated re-driver (the
reactor toggle/cron ideas above, or a per-PRD reactor) must independently re-wire the
same subtract+record dance, or silently reintroduce the infinite-retry loop with no
compile error. A deeper version would make suppression a first-class concern of the
spawn edge (an optional injected failed-set the edge consults and records into),
collapsing the two asymmetric integration points (implementor: a `subtractFailed…`
filter pass; reviewer: an inline `failed.has(…)` check) into one parameterized
mechanism. Deferred from the v1 Reactor to keep the proven spawn-edge core unchanged.

### Single helper for the PRD feature-branch derivation

`featureBranchName(basename(prdDir))` is now computed independently in three places
(the dispatcher, the reviewer, and the Reactor). The derivation is load-bearing — it
must agree across all three so the dispatch worktree base, the review merge target, and
the Reactor's automated spawns all target the same branch — yet nothing enforces that
agreement. A small shared `prdFeatureBranch(prdDir)` helper would make the rule a single
edit if the branch-naming convention ever changes (e.g. gains a prefix). Low-risk
cleanup, deferred to avoid touching the shared edges in the review-fix pass.
