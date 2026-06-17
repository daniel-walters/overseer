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

### Create the PRD feature branch up front and commit CONTEXT/ADRs onto it before dispatch

Today the per-PRD **feature branch** is created *lazily, at dispatch time* —
`gitSetup` ensures it exists and checks it out the moment you press `d` (CONTEXT.md →
Where the work happens). But the domain docs a PRD depends on — the new `CONTEXT.md`
glossary terms and ADRs produced during the `grill-with-docs` session — are authored
*earlier*, before any branch exists for the feature. So they land on whatever branch
the checkout happened to be on during the grill, **divorced from the branch the agents
will later build on**. The dispatched implementors then start from a feature branch that
*doesn't contain the glossary/ADRs that justify their work*.

This actually bit a real dogfood run: the suppressed-marker grill wrote the Suppressed
glossary entry + ADR 0011 onto a stray branch, while the agents dispatched off a
separate feature branch with neither — the docs had to be cherry-picked across
afterward to reunite them. The lazy branch creation is the root cause.

The idea: **create the PRD feature branch early** — at PRD authoring / grill time, not
dispatch time — and **commit the CONTEXT/ADR changes onto it then**, so that:

- the feature branch is the single home of *both* the feature's docs and its code from
  the start;
- every dispatched agent inherits the glossary and ADRs as its base, so an implementor
  reads the canonical domain language for the work it's doing (today it only gets what's
  in the Issue/PRD files);
- there's no post-hoc reconciliation of stranded docs.

Open questions: which skill owns branch creation (`grill-with-docs`? `to-prd`?), given
those skills currently only touch the Overseer root and domain docs, never git branches
— this would give them a new git responsibility. How does the branch name get derived
before dispatch (it's `featureBranchName(prd-dir)` today, derivable from the PRD slug
the moment the PRD folder is named, so the name is available early). What happens to the
"created lazily at dispatch, idempotent if present" contract in `gitSetup` — it would
become "ensure it exists, usually already does." And: does committing docs onto a
feature branch *before* the work is even dispatched feel right, or should the docs land
on `main` directly (they're decisions, not feature code) and the feature branch simply
branch off an up-to-date `main`? That last framing might be the cleaner fix — the real
bug may be that the docs never reached `main` at all, not that the branch was late.

### (Deferred) Multi-repo PRDs: one PR per repo

The **Open PR** / **Linked PR** flow has shipped (CONTEXT.md → Open PR, Linked PR),
scoped to **single-repo PRDs only**. This is the deferred follow-up that extends it to
PRDs whose Issues span multiple repos.

A PRD's **feature branch is per-repo**, not per-PRD: `featureBranchName(prdDir)` is
derived from the PRD directory name, but `gitSetup` creates and checks it out **once per
repo per dispatch**, and each Issue carries its own `repo:`. So a PRD whose Issues span
repos A and B has the *same-named* feature branch in *both* (`quick-wins` in A **and** in
B), each sitting unmerged against its own repo's default branch — i.e. **a multi-repo PRD
needs one PR per repo**, not one PR. "One PRD → one PR" is only true for a single-repo PRD.

The shipped single-repo cut handles this case by **refusing** it: `open PR` opens the one
PR from the PRD's single feature branch, and on a PRD whose Issues span multiple distinct
`repo:` values it **explicitly refuses** with a visible status-line message ("this PRD
spans N repos; open a PR per repo manually") rather than a silent no-op or a crash. Every
PRD built so far is single-repo, so this defers a case not yet hit without pretending it
can't happen.

The deferred follow-up: make `open PR` enumerate the distinct repos across a PRD's Issues
and open **one PR per repo** (each from that repo's feature branch into that repo's default
base), turning the linked-PR icon, `go to PR`, and the link storage from a single value into
a **collection per PRD** — and the confirm modal into a preview of N PRs into N repos. Worth
building only once multi-repo PRDs are real.

### Keybind to advance a human-held Issue (mark done / mark for review)

A human-held Issue has **no board action to move it on** — the human must hand-edit the
frontmatter `status`. Two states sit in human hands:

- **`ready-for-human`** — an Issue routed for a *human* to implement (HITL), parked in the
  **ready** column with its badge. When the human finishes the work, nothing on the board
  advances it: the natural next states are **`done`** (it's complete) or **`ready-for-review`**
  (hand the result to the AI review loop, exactly as a finished agent Issue parks at
  `ready-for-review`). Today both require editing the file by hand.
- **`human-review`** — an escalated Issue (deviation / non-convergence / conflict) whose
  **single exit is `done`** via the bundled `overseer-merge` skill. "Mark done" here already has
  a path, but it's a skill run outside the board, not an in-board keypress.

The idea: a keybind on a human-held card to **mark it `done`** or **mark it `ready-for-review`**,
so the human can advance their own work from inside the board the same way `d`/`r` advance agent
work — no dropping out to edit YAML. Most directly it fills the `ready-for-human` gap (which has
*no* affordance at all); "mark done" also generalises to `human-review`'s done-exit, though that
one already has the merge skill and a keybind there must not bypass the worktree merge the skill
performs (a `human-review → done` that doesn't merge the branch would mark work done without
landing it).

Open questions: (1) which transitions each keybind offers per state — `ready-for-human` →
{`done`, `ready-for-review`}, and whether `human-review` → `done` belongs here at all or stays
with `overseer-merge` (since it must *merge*, not just flip status); (2) this is the board's first
keybind that writes a **status flip with no spawn** — every status-writing action today either
spawns an agent (`d`/`r`) or is the agent/skill writing its own transition, so a bare human
"advance status" keypress is a new actor on the file, worth confirming it still respects the
[ADR 0002](./adr/0002-agents-write-the-root-viewer-stays-readonly.md) writer contract; (3)
whether it needs a confirm step (a status flip is cheap and reversible by re-editing, unlike the
outward writes `d`/Open PR make, so probably a bare keypress is fine); (4) gating — the keybind is
Issue-level and only lights up on a `ready-for-human` (and possibly `human-review`) card. Pairs
with the central keybind registry (now `done`) — register the new binds there.

### Jump straight to an Issue needing human review

`human-review` is the *one* column in the whole pipeline that requires a human
(CONTEXT.md → Issue status) — yet the board gives it no special way to *find* it. Today
navigation is entirely manual and local: move within a column (`hjkl`), zoom into one
PRD, back out. To reach a `human-review` Issue you must already know which PRD holds it,
navigate to that PRD's card, zoom in, and move to the Issue. Across many PRDs an
escalated Issue is a needle you hunt for — and it's the highest-priority thing on the
board, because the whole automated pipeline is *blocked on you* for it.

The idea: a **one-keypress jump** to the next Issue awaiting human review — select it
(zooming into its PRD as needed) wherever it lives, so the human attention the board
exists to direct lands instantly. Pressing it again cycles to the next one (round-robin
through all `human-review` Issues across all PRDs).

Design questions: ordering when several await (oldest first? by `human_review_reason`
severity — conflict before deviation? board order?); what it does when there are none
(no-op, or a "nothing needs you" status-line flash); whether it's purely a *jump* or
also previews *why* (the `human_review_reason` is already on the card as a marker, so
the jump may be enough). It pairs with the per-PRD-pause idea's "where's the work"
question and is a natural member of whatever the "central keybind registry" becomes.

A small generalisation worth noting: this is the first **cross-PRD jump** keybind —
every nav action today is within the current level/column. The same machinery (find the
next card matching a predicate, select it, zoom if needed) would also serve "jump to the
next orphan" or "next suppressed" later, so it may be worth designing as a general
"jump to next card matching X" rather than a one-off human-review jump.

### Delete a done PRD and its Issues with a keybind

Once a PRD is `done` (and presumably its work merged / PR'd), its folder is clutter on
the board — the work is over but the cards stay forever. A keybind to **delete a done
PRD's directory and all its Issue files** in one gesture would let the board be tidied
from inside it, instead of `rm -rf`-ing the folder out-of-band.

This one collides head-on with a core invariant, which is the whole reason it needs a
design pass rather than a quick keybind: **the board has never written to the watched
root.** Every file mutation in the system today is an agent/trigger flipping a
*status* (`writeStatus`); nothing, anywhere, *deletes*. A delete keybind makes the
read-only viewer (ADR 0002) perform its **first destructive write to the root** — and
not a status transition but the removal of domain data outright. That's a real boundary
crossing, not an extension of an existing pattern.

Tensions to resolve before building it:

- **Read-only contract (ADR 0002).** The board reflects files; agents write them. A
  delete is the *board itself* writing (removing) — a new actor on the root. Is that an
  acceptable exception for an explicit, human-only, done-gated destructive action, or
  does deletion belong in a skill (like merge) run outside the board, keeping the TUI a
  pure viewer? Leaning skill-vs-keybind is the first fork.
- **Irreversibility + confirmation.** Deleting a folder of markdown is hard to undo
  (no git in the root — it's not a repo). This needs a real confirm modal (like the
  dispatch/review previews), not a bare keypress, and probably a `done`-only gate so a
  fat-finger can't wipe in-flight work. Consider whether "delete" should mean *move to
  a trash/archive area* rather than hard-remove, so it's recoverable.
- **What "done" guarantees.** A `done` PRD's work lives on its feature branch (and
  maybe a PR) — deleting the PRD/Issue *files* doesn't touch that code. Worth stating
  so a user doesn't think deleting the cards deletes the work. Conversely, should delete
  be blocked until the PR is merged (tie-in with the "open/link a PR" idea), so you
  can't discard the only record of unmerged work?
- **The live re-scan handles the rest for free.** Once the files are gone, the
  watcher's debounced re-scan rebuilds the board without them (the same path that
  already tolerates a folder vanishing out-of-band) — so the *rendering* side is
  solved; only the *act* of deleting is new.

Pairs with the per-PRD-pause and archive notions — "what do you do with a PRD you're
finished with" is a small cluster: pause, archive, delete.

### (Discussion) Finished agents linger in `claude agents` — clean up, or keep for post-mortem?

*Captured as an open discussion point, not a decided direction.*

Observation: as agents finish, they don't disappear from `claude agents` — they move
to a **completed** area and stick around. The first instinct is that they should be
**fully deleted** once done; a growing graveyard of finished sessions is clutter, and
it interacts with a known liveness quirk — a lingering completed row still counts as
`live` in the membership test (the "membership is id-only" known limit in
`liveness.ts`), so an agent that has actually exited can read `live` until its row ages
out.

But — counter-thought — **a user may want to inspect a finished agent's logs
post-mortem**: what did the reviewer actually find, why did this implementor deviate,
what did a failed run print. Hard-deleting on completion destroys exactly the artifact
the deferred "Per-agent logs from a card" idea wants to surface. So "delete when done"
and "keep logs around" pull in opposite directions.

The discussion, unresolved:

- **Is cleanup even Overseer's job?** The completed rows are Claude's session
  registry, not Overseer state. Overseer spawns and forgets (ADR 0002); reaching in to
  `claude` to delete finished sessions is a new outward action with its own surface.
- **Retain-then-reap vs. delete-on-done.** Maybe the answer isn't binary: keep
  completed sessions for some window (or until merge), then reap — so post-mortem is
  possible *and* the graveyard is bounded. What's the right trigger to reap (merge of
  the Issue? board reopen? a TTL?)?
- **Decouple logs from session lifetime.** If `claude logs <handle>` survives session
  deletion (Claude persists logs independently of the live-session row), then we can
  delete the row freely and still inspect post-mortem — which would dissolve the
  tension entirely. **Needs verifying** before any cleanup is built: it decides whether
  this is even a real trade-off.
- **The liveness angle is the concrete cost of doing nothing.** Left alone, lingering
  completed rows keep faking `live` verdicts. Reading the row's `state` to call a
  completed session dead is the "is it hung?" iteration liveness already defers — so
  this discussion overlaps that one too.

Resolve the "do logs outlive the session?" question first; it likely collapses the
whole fork.

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
  coexist with the alt-screen board that still *clips* horizontally on overflow (see
  "Horizontal paging across columns" below)? Live log tailing inside Ink is real UI work.
- **Overlaps "is it hung?".** The `state: working/idle/blocked` field liveness already
  captures is the *cheap* signal and may answer "what's it doing" 80% of the time; full
  logs are the *expensive* signal to reach for when `state` isn't enough.

So: a natural follow-on now that the liveness handle has landed, but its own UI-shaped
piece of work, not part of the dogfood-minimum set.

This is one of the **pane-shaped ideas** that want the same per-Issue detail surface.
See "The shared detail surface" (next) for the framing.

### The shared detail surface

The **static body view shipped** as the detail modal — `v` opens a full-screen,
scrollable, markdown-rendered view of the selected card's frontmatter-stripped body
(the PRD's `prd.md` at board level, the selected Issue's file when zoomed), via
[ADR 0014](./adr/0014-detail-body-rendered-through-marked-terminal.md). That establishes
the rendering surface the remaining pane-shaped ideas can reuse:

1. **"Per-agent logs from a card"** (above) — the selected agent's `claude logs` output
   (live stream rather than static text).
2. **"A detail pane / expand-on-select"** (under "more real estate for Issue titles") —
   full title overflow + body + deviation reason for the selected card, *in context*
   beside the board rather than as a full-screen takeover.

Both are the same surface viewed differently (live log stream / in-context overflow
detail) and can build on the modal's body-rendering + scrolling rather than reinventing
it — though the log stream adds a subprocess + live tailing, and the in-context variant
adds the harder question of sharing the screen with the (clipped) board rather than
taking it over.

### Pause / resume development of a PRD

A way to pause and later resume development of a PRD. While paused, the dispatcher
should not spawn (or keep spawning) agents for that PRD's issues; resuming picks
development back up. Open questions: where does the pause state live (PRD frontmatter
vs. external state, given Overseer is a read-only viewer of the files), how it surfaces
on the board, and how in-flight agents are handled at the moment of pausing.

### Show the AI-review iteration count on an in-review card (e.g. `2/3`)

While an Issue is `in-review`, surface how many `/code-review` passes it has been
through and the cap before it escalates to a human — a `2/3`-style marker on the card.
It answers "is this review nearly out of road?" at a glance: a card at `1/3` is fresh,
one at `3/3` is about to either pass clean or land in `human-review` for
non-convergence.

The catch: **that count does not exist anywhere Overseer can read it today.** The
loop runs entirely *inside a single reviewer agent's session* — the reviewer spawns
once, loops `/code-review` up to the cap in-process, and writes back only a *terminal*
status (`done`, or `human-review` with a reason like `non-convergence`). The iteration
number lives in the agent's head, never on the Issue file or a sidecar (CONTEXT.md →
Review outcome). So this is **not a rendering tweak** — it needs the count *exposed*
first, and the cleanest way to expose it is to stop the agent owning the loop at all.

**Resolved design (grill session, 2026-06-17): build this together with "Use a fresh
reviewer agent for each review iteration" below — they are one change to the review
loop, not two.** Once each pass is its own spawn driven by the Reactor, the count is a
near-free rider:

- **Loop ownership inverts.** The `/code-review` loop moves out of the reviewer prompt
  and into the Reactor. Each pass is its own spawn on the *existing* review edge.
- **Between passes, the Issue returns to `ready-for-review`.** A pass that found-and-
  fixed issues sets status back to `ready-for-review`; the Reactor re-picks it up. No
  new status — the awaiting→active flip stays the idempotency lock. The card visibly
  oscillates `ready-for-review ⇄ in-review`, one hop per pass; accepted as honest
  (column = on-disk status, the viewer invariant holds).
- **The count lives in the agent sidecar (`agents.json`), Overseer-written per spawn.**
  Because the Reactor drives each pass, *Overseer* increments and records the count at
  spawn time — no agent ever writes the sidecar, so the "only Overseer writes
  `agents.json`" invariant (ADR 0008) survives untouched. The value grows from
  `string` (handle) to `{ handle, reviewPass }`. This sidesteps the earlier dilemma
  (agent-writes-the-Issue vs agent-writes-a-sidecar) entirely: the *agent* never writes
  the count under this model.
- **The count is both control and display.** Overseer reads `reviewPass = N`: if
  `N ≥ config.review.cap` it routes to `human-review` (non-convergence) instead of
  spawning; else it spawns pass `N+1` and records it. The card marker is that same
  number — one source of truth for control, marker, and the cap config.

The marker itself: `N/cap`, where **N = the currently-running pass** (starts at
`1/cap`) and **cap = `config.review.cap`** (already configurable today — see the
correction note below; it is *not* a hardcoded 3). Rendered **neutral**, deliberately
outside the yellow "needs-a-human" and red `⊘` "nothing-ran" marker families — it is
the healthy in-progress path, not a warning. **Live-gated, like all sidecar overlays:**
the marker shows only for a *live* `in-review` agent. If the agent dies mid-loop the
Issue becomes an `in-review` Orphan — the **Orphan marker wins and the count is
hidden** (a dead agent is not "on pass 2" of anything).

> **Doc correction:** "Configurable AI-review turns and effort" has **shipped** —
> `config.review.cap` / `config.review.effort` (the `[review]` TOML table, default cap
> 3 / effort medium) is built and tested (`src/config.ts`, `src/review/reviewConfig.ts`).
> CONTEXT.md still says the cap is "deliberately hardcoded for v1"; that line is stale.

### Use a fresh reviewer agent for each review iteration

Today all 3 review passes run in **one reviewer session**: the same agent runs
`/code-review`, fixes the findings *itself*, then re-runs `/code-review` on its own
fixes, up to the cap (`reviewerPrompt.ts` → How to review). That's a known reviewer
bias — an agent grading work it just produced is inclined to bless it. The idea: spawn
a **separate reviewer agent per iteration**, so each pass is a fresh pair of eyes on
the current state of the worktree, with no memory of having written the fixes under
review.

Why it might be better: independence. A clean-slate reviewer that never saw the prior
fix is more likely to catch a flaw the author-reviewer rationalised away; convergence
("a pass reports zero findings") means more when the passing reviewer has no stake in
the code. It also separates the two jobs the single agent currently fuses — *review*
(find problems) and *fix* (resolve them) — which arguably want different agents
anyway.

Costs / open questions to weigh:

- **Who fixes?** *(Resolved, grill session 2026-06-17: the same per-pass agent both
  reviews and fixes — but it **reviews first**, so there is no author-reviewer bias.)*
  Each pass agent reviews the worktree *as it inherited it* (code written by the
  previous pass's agent, or the implementor on pass 1) — it has no stake in that code —
  and only *then* fixes the findings it reported. The independence the fresh-reviewer
  idea is after holds at the **pass boundary**, not within a pass: the agent that fixes
  in pass N is gone by pass N+1, so pass N+1's fresh agent reviews those fixes with no
  memory of making them. No separate fixer agent, no new loop edge — every agent only
  ever *judges* code it did not write.
- **State handoff.** A single session carries context across passes for free; separate
  agents need the findings/fixes passed between them (via the worktree commits, or an
  explicit handoff artifact). The worktree *is* the shared state, so a fresh reviewer
  reading the latest commit may be enough — worth confirming.
- **Cost & latency.** N spawns instead of 1 per Issue, each paying cold-start +
  worktree checkout. Wider fan-out against the same shared-checkout concerns dispatch
  already navigates.

**Resolved with the iteration-count idea (grill session, 2026-06-17): build the two
together.** Each pass becoming its own Reactor-driven spawn is what makes the count
(`N/cap`) clean — *Overseer* records the pass number in `agents.json` at spawn time, so
no agent self-reports it, and the same number both drives the cap (spawn pass N+1 vs.
escalate at `N ≥ cap`) and renders the marker. The loop moves from the reviewer prompt
into the Reactor; between passes the Issue returns to `ready-for-review` and the Reactor
re-picks it up (no new status). See the full resolved design under "Show the AI-review
iteration count" above.

This is a meaningful change to the review model (ADR 0005 territory — the review
reactor), not a prompt tweak; the combined design above is that design pass.

### Overseer owns the review merge + terminal status write (not the agent)

**Motivated by a real dogfood failure (2026-06-17):** Issue 002 of the
`reviewer-iteration-count` PRD got **wedged in `in-review`**. The reviewer agent ran
`/code-review`, found nothing, committed — and then simply *stopped*, never running the
two terminal steps the prompt instructs: merge the worktree branch into the feature
branch and write `status: done`. The work sat committed on the branch, the merge was
conflict-free, no deviation was recorded — a textbook clean exit — yet the Issue stayed
`in-review` forever and had to be finished by hand (`overseer-merge`).

The root cause is structural, not a flaky run. Overseer flips an Issue
`ready-for-review → in-review` *before* spawning (flip-before-spawn is the idempotency
lock, [ADR 0002](./adr/0002-agents-write-the-root-viewer-stays-readonly.md)), and from
that point **the agent is the only thing that ever writes the terminal status** — Overseer
never merges or sets `done` itself. The Reactor only re-spawns reviewers for
`ready-for-review` Issues, so once an Issue is `in-review` the Reactor never touches it
again. Result: a reviewer that dies, runs out of turns, or just stops after reviewing but
before the merge+`done` hop leaves the Issue **permanently stuck with no retry and no
board signal that anything is wrong**. (The liveness Orphan verdict only fires for
`in-progress`/`in-review` *with a recorded handle*; even then it tells you the agent is
gone, not that the merge it should have done is undone.)

The idea: **move the merge and the terminal status write off the agent and into
Overseer.** The pass agent reports a *verdict* — clean / findings-fixed / deviation /
conflict — and Overseer performs the merge and writes `done` (or `human-review` with the
reason). This kills the whole class of "agent reviewed but never finished" bugs at the
source: the terminal transition becomes a deterministic, Overseer-owned step that either
happens or visibly fails, never silently half-completes.

This is the same direction as
[ADR 0018](./adr/0018-reactor-owns-the-review-loop-not-the-agent.md) (the Reactor owns the
review *loop*) taken one step further — note that **0018 as written does *not* fix this**:
even under per-pass spawns, the *clean exit* (merge + `done`) is still the agent's job, so
a pass agent that stops before the merge wedges identically.

**This is a deliberate follow-up *to* 0018, not part of it.** 0018 is in flight; the two
are separable axes — 0018 decides *who drives the passes* (the Reactor), this decides *who
writes the terminal state* (Overseer). Bundling them would let the harder verdict-handoff
design (below) block the loop rework that already works, and 0018 doesn't make this any
harder to add afterward (same review edge). At the observed ~1/35 failure rate it does not
justify halting in-flight work — so let 0018 land single-pass-prompt + Reactor-cap as
scoped, then pick this up as its own slice. (Cheap interim while it waits: a detection
backstop that surfaces a stalled `in-review` — dead handle, no terminal status — on the
board, so the next occurrence is *visible in seconds* instead of found by luck, reusing the
existing Orphan machinery. That converts the failure from silent-wedge to obvious-card for
a fraction of the risk of the full inversion.)

Open questions:

- **How does the agent report the verdict without writing the Issue?** The whole point is
  that the agent stops *short* of the terminal write. Options: a tiny verdict artifact in
  the worktree the Reactor reads, the agent's exit/output parsed by Overseer, or
  reusing the sidecar (but that reintroduces the "agent writes `agents.json`" tension
  [ADR 0008](./adr/0008-liveness-via-claude-agents-handle-sidecar.md) forbids). The
  verdict must be unforgeable enough that Overseer doesn't merge on a half-finished run.
- **Who runs `git merge`?** Today the agent runs it in the repo. Moving it to Overseer
  gives the read-only viewer its *first outward git write* to a repo (distinct from the
  root-write contract) — but the Reactor already owns a `git` seam for the implementor
  edge, so this extends an existing seam rather than inventing one. The conflict→abort→
  `human-review` path moves with it.
- **Interaction with the failed-set / idempotency lock.** If Overseer owns the merge, a
  clean verdict that fails to merge (conflict) is *Overseer's* rollback to `human-review`,
  not the agent's — cleaner, since it's the same actor that flipped the lock.
- **A stalled-`in-review` reaper as a cheaper interim?** Short of the full inversion, a
  reaper that detects an `in-review` Issue whose handle is dead and rolls it back to
  `ready-for-review` would unstick the symptom — but it risks a double-merge if the agent
  *had* started merging, and re-runs a clean review for nothing. The verdict-handoff above
  is the real fix; the reaper is a band-aid worth naming so it's a conscious rejection,
  not an oversight.

Pairs with "Show the AI-review iteration count" and "Use a fresh reviewer agent for each
review iteration" (the ADR 0018 cluster) — all three reshape who-owns-what across the
review loop, and this one closes the gap those leave open.

### Auto-resolve trivial merge conflicts instead of always escalating

Today a merge conflict is treated as **uniformly un-automatable**: when the reviewer's
clean-AI merge of the Issue's worktree into the PRD feature branch hits *any* conflict,
it escalates straight to `human-review` with `human_review_reason: conflict` — "never
auto-resolved by an agent" (CONTEXT.md → Review outcome). But conflicts are not uniform.
In parallel work the feature branch moves under sibling worktrees constantly, and a large
share of the resulting conflicts are **trivial** — two siblings each appended an import,
both added a case to the same `switch`, an Issue file's `NNN-` numbering brushed a
neighbour. A human resolving those is doing rote work an agent could do as reliably as it
does the rest of the review. Escalating *every* conflict makes `human-review` — the one
queue meant for genuine human judgment — the dumping ground for mechanical merges too,
diluting the signal that the column is supposed to carry.

The idea: let the reviewer **attempt** a conflict resolution, and escalate to
`human-review` only when the conflict is **non-trivial** or the attempt doesn't cleanly
converge. A merge conflict stops being an automatic terminal state and becomes one more
thing the AI review loop tries first — exactly as it already tries `/code-review` fixes
before giving up.

The whole difficulty is **defining "trivial" safely**, because the cost of getting it
wrong is asymmetric: a wrongly-auto-resolved conflict is *silently incorrect merged code*
on the feature branch, which is far worse than the conservative status quo of bothering a
human. So the bar for "trivial" must be high and the failure mode must be "escalate," never
"guess." Open questions:

- **What counts as trivial, and who judges?** A mechanical heuristic (e.g. non-overlapping
  hunks, conflict confined to import blocks / additive-only regions), or the reviewer agent's
  own judgment with an explicit instruction to escalate on any doubt? Agent-judgment is more
  flexible but reintroduces exactly the self-grading bias the "fresh reviewer per iteration"
  idea above is wary of — an agent motivated to finish may rationalise a risky resolve as
  trivial. A conservative mechanical gate *in front of* the agent attempt may be the safer
  shape.
- **Does the resolution get re-reviewed?** A conflict the agent resolves changes the merged
  diff — it should arguably go back through `/code-review` (or a fresh reviewer, per the idea
  above) rather than merging unseen. That couples this to the review-loop shape: an
  auto-resolved conflict is a new diff to certify, not a done deal.
- **A new `human_review_reason`, or a record of the auto-resolution?** When it *does*
  escalate, the reason is still `conflict`. When it *succeeds*, should the merge note that it
  auto-resolved a conflict (so a human can audit it post-hoc), or is a clean `done` enough?
  An audit trail matters more here than on a normal clean merge, precisely because the agent
  touched conflicting code.
- **Config knob for the appetite.** Like the hardcoded review cap, "how hard should the
  reviewer try to auto-resolve" might want to be a `config.toml` dial — off (today's behavior,
  always escalate), trivial-only, or aggressive — so a cautious operator can keep the current
  guarantee. Pairs with "Configurable AI-review turns and effort" (now in the `quick-wins`
  PRD): same instinct of promoting a baked-in review-loop default to a knob.

This changes the review-merge contract (CONTEXT.md → Review outcome) and is ADR 0005
territory — the review reactor — not a prompt tweak. It pairs with "Use a fresh reviewer
agent for each review iteration" above (both reshape what the reviewer does and when it
escalates) and should be designed alongside it if both are pursued.

### Design-aware evaluation for frontend Issues (pre / during / post coding)

Overseer's implement→review loop is **design-blind**: an implementor reads the Issue +
PRD prose and writes code, and the reviewer loops `/code-review` over the diff
(`reviewerPrompt.ts` → How to review). Nothing in that loop knows what the frontend was
*supposed to look like*. For backend Issues that's fine — correctness is in the code and
the tests. For **frontend** Issues it leaves the highest-value question unasked: does the
built UI actually match an intended design? A `/code-review` pass can bless code that
compiles, tests green, and renders something — while looking nothing like what was wanted.

The idea: a **design-aware track for frontend Issues** that threads an intended design
through the whole lifecycle, touching multiple layers rather than being one prompt tweak:

1. **Pre-coding — ask for a design first.** A frontend Issue should not dispatch straight
   to an implementor with only prose. It should first **solicit a design** (a mockup,
   reference image, component spec, or at minimum an explicit written design intent) so
   the implementor has a target. Open question: is the design a *human* input gathered at
   authoring time (the `overseer-to-issues` / grill stage attaches it), or does a
   design-agent generate one for human sign-off before coding? Either way this is a new
   **gate before dispatch** for design-bearing Issues — a frontend Issue with no design is
   not yet `ready-for-agent`.
2. **During coding — adhere to the design.** The implementor prompt
   (`buildImplementorPrompt`) must carry the design into the build and instruct the agent
   to build *to* it, not just to the prose. That means the design artifact has to travel
   with the Issue (where does it live — an attachment in the PRD folder, a path in the
   Issue frontmatter?) and be referenced in the prompt the way the PRD body is today.
3. **Post-coding — review *against* the design.** The reviewer's `/code-review` loop
   checks code, not appearance. A design-aware review needs to **render the built UI and
   compare it to the design** — which means the reviewer gains a capability it has never
   had: actually *running* the frontend and looking at it (screenshot diffing, a
   vision-model "does this match the mockup?" pass, or visual-regression tooling), not
   just reading the diff. Convergence for a frontend Issue would then mean "code-review
   clean **and** matches design," with a mismatch as its own escalation — plausibly a new
   `human_review_reason` (e.g. `design-mismatch`) alongside the existing
   deviation / non-convergence / conflict set (`reviewerPrompt.ts` reason vocabulary).

Why it's cross-cutting and not a quick win: it touches **authoring** (capture/attach a
design), **dispatch eligibility** (a frontend Issue isn't ready without one), the
**implementor prompt** (build to the design), and the **review loop** (a wholly new
evaluation mode that renders and visually compares — the reviewer's first capability
beyond reading code). It also raises the **classification** question: how does Overseer
know an Issue is "frontend" and therefore design-gated — a label/tag, a heuristic, an
explicit Issue field? That gate is the linchpin; without it the track can't selectively
apply.

Pairs with several existing review-loop ideas. "Use a fresh reviewer agent for each
review iteration" and "Configurable AI-review turns and effort" are the same review-loop
surface this would extend — a visual-comparison pass is one more thing a (possibly fresh)
reviewer does, under its own config knob. And it shares the "reviewer gains a new
capability beyond reading files" shape with "Per-agent logs from a card" (subprocess /
new IO from a read-only-ish loop). This is ADR 0005 territory (the review reactor) plus a
new pre-dispatch gate — a meaty multi-layer feature deserving its own grill + PRD, not a
prompt edit.

### Horizontal paging across columns (overflow on the alternate screen)

"Always full screen" (UI Polish part 1) renders the board on the terminal's
**alternate screen buffer** (à la vim/htop), sized to fill the viewport. The alt
buffer has **no scrollback** (standard terminal behaviour — Ink's own docs warn of
it), so overflow is clipped rather than terminal-scrollable.

**Vertical** overflow within a column is now solved: a column taller than the viewport
renders only its visible window and scrolls to follow the selection (shipped,
[ADR 0015](./adr/0015-2d-nav-with-vertical-only-selection-following-scroll.md)), so no
card is unreachable *down* a lane. What remains is the **horizontal** axis: with more
columns than fit the terminal width, the rightmost columns clip at the screen edge with
no way to page across to them. The follow-up is **horizontal paging / virtualization
across columns** so a wide board (the 7-column Issue level on a narrow terminal) stays
fully reachable left-to-right. Until then, a narrow terminal can hide whole columns.

### Brainstorm: more real estate for Issue titles

Titles can still be cramped. Two of the original width pressures have since been
relieved — column width is now **adaptive** (divided across the visible columns
rather than a hardcoded 24, shipped), and selection no longer prepends a `▶ ` arrow
that ate two title columns (selection is now the cyan border alone, shipped). What
remains is the per-card chrome tax and single-line truncation. Candidate directions
still on the table:

- **Drop per-card chrome.** The rounded border + padding on *every* card is a heavy
  per-card tax on width and vertical space. A lighter separator (a rule, or just
  spacing) between cards could reclaim the 2 border + 2 padding columns for the
  title. Selection could then be the *only* thing that draws a box (the cyan border
  is already the sole selection cue, so this fits cleanly).
- **Wrap instead of truncate.** Let a long title wrap to two lines (`wrap="wrap"` /
  truncate at line 2) rather than hard-truncating at one. Costs vertical space —
  trades against the overflow/clipping limit — but a title you can fully read may be
  worth a taller card. Possibly only for the *selected* card (expand-on-select).
- **A detail pane / expand-on-select.** Keep cards terse, but show the full title
  (and body, deviation reason, etc.) for the selected Issue in a side or bottom
  pane. The card list stays scannable; the focused Issue gets unlimited room. This
  is the biggest change and is one of the **pane-shaped ideas** that share one
  detail surface — see "The shared detail surface" note for the design-the-pane-once
  framing. (The static body view itself has shipped as the detail modal; this is the
  *per-card-in-context* variant.)

### Surface "stalled — auto-run off, work waiting" on the board-level PRD card

Surfaced while designing **dynamic keybinds** ([ADR 0017](./adr/0017-keybind-eligibility-gates-matcher-and-hints-but-not-the-help-map.md)). Scenario: [auto-run](../CONTEXT.md#auto-run) is **off**, a PRD is **in-progress**, nothing is in flight, yet it has an unblocked `ready-for-agent` Issue waiting (a blocker just hit `done`). The pipeline is **stalled on you** — nothing will pick that work up until you press `d` (the manual re-dispatch crank). But the board cannot show this: a stalled-with-pending-work PRD looks **identical** to an in-progress-and-humming one. The activity signal says `⏸ auto-run off` / `□ at-rest` (the brake is on) but nothing says *there is dispatchable work nobody is coming for*, and the `ready-for-agent` card is only visible once you zoom in.

Dynamic keybinds (ADR 0017) *partly* address discoverability — `d` lights up in the hints exactly when its frontier has a spawn candidate, and reads **"resume"** rather than "dispatch" on an in-progress PRD — so once you have the PRD selected, the affordance is legible. What remains is the **board-level, at-a-glance** signal: a PRD-card marker (the same Issue→PRD roll-up shape as the human-intervention idea below) that flags *"this PRD has unblocked agent work but nothing is running"* — so you can see *which* PRDs are stalled without selecting each one. Pairs tightly with "Surface needs human intervention on the board-level PRD card" (next) — both roll an Issue-level fact up to the PRD card to answer "where is the work blocked on me?" at the board level; this one's trigger is *unblocked-but-undispatched agent work under a released-or-braked Reactor*, that one's is *human-review*.

### Surface "needs human intervention" on the board-level PRD card

At the **board level** the cards are PRDs across three derived columns (backlog /
in-progress / done) and they carry **no markers at all** — every marker family
(liveness, suppressed, human-review reason, malformed-status) is an *Issue-level*
overlay, visible only once you zoom into a PRD. So a PRD with an Issue parked in
`human-review` — the one column in the whole pipeline that is *blocked on a human*
(CONTEXT.md → Review outcome) — looks, from the board, exactly like a PRD that is
humming along under the reactor. The single most important thing a PRD could tell
you ("the automated pipeline has stalled here and is waiting on *you*") is the one
thing the board-level card cannot currently show. You only discover it by zooming
into each in-progress PRD and hunting.

The idea: a **board-level PRD card marker** that lights up when *anything inside that
PRD needs human intervention* — most concretely, ≥1 Issue in `human-review`, but
worth deciding whether it also covers the other "stuck, needs a human" states
(`ready-for-human` waiting to be picked up; an [Orphan](#); a `⚠ bad status` Issue).
It rolls an Issue-level fact *up* to the PRD card so the board answers "which PRDs
need me?" at a glance, without zooming.

Open questions:

- **What counts as "needs intervention"?** The tightest definition is *any Issue in
  `human-review`* (the genuine human-attention queue). A looser one also rolls up
  `ready-for-human` (HITL work not yet done), orphans (`R`-recoverable), and
  malformed-status Issues (frontmatter to fix). Each is a real "a human must act"
  state, but they want *different* actions — so a single undifferentiated marker may
  under-inform. Does the PRD marker collapse them into one "⚠ needs you" glyph, or
  carry a count / the dominant reason?
- **It's a derived roll-up, not stored state.** Like every other marker it must be
  computed from the Issues at scan time (ADR 0002 / ADR 0003) — the PRD has no field
  of its own. The board already derives a PRD's *column* from its Issues; this is the
  same shape (derive a PRD-level *marker* from its Issues), so it fits the existing
  derivation pass and writes nothing.
- **Where it sits.** The board-level PRD card is currently marker-free except the
  `done`-only [Linked PR](#) overlay. This would be the **first Issue→PRD roll-up
  marker** and the first marker an *in-progress* PRD card carries — worth confirming
  it reads as its own line (the established marker idiom) and how it coexists with the
  Linked PR marker (disjoint columns — Linked PR is `done`-only, human-review implies
  not-done — so they likely never co-render, same as the Issue-level families).
- **Counting.** If several Issues in one PRD need a human, does the marker show a
  count ("⚠ 2 need you") or just presence? A count makes the board a triage surface;
  presence is simpler.

Pairs tightly with the "Jump straight to an Issue needing human review" idea above —
that one *navigates* to the escalated Issue; this one *reveals at the board level
which PRD holds it*. Together they answer "where is the work blocked on me?" both at a
glance (this marker) and with a keypress (that jump). Designed together, the marker is
the signal and the jump is the action it invites.
