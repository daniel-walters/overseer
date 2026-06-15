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

### Open / link a GitHub PR for a done PRD

A finished PRD currently dead-ends. The whole flow merges Issue worktrees into the
**PRD feature branch** (e.g. `suppressed-marker`) and stops there — "merging that
branch to `main` is out of scope for this flow" (CONTEXT.md → Review outcome). So a
`done` PRD is a feature branch with all its work merged in, sitting unmerged against
`main`, with no PR. This idea closes that last gap with three keybinds/affordances:

1. **`open PR` keybind on a done PRD.** Board-level action on a PRD in the `done`
   column: open a GitHub PR from its feature branch into `main` (the default base),
   titled from the PRD. This is the deliberate human gate the flow intentionally stops
   short of — the agent never opens PRs (the implementor prompt says so explicitly),
   so this is a human-triggered, board-level act, sibling to `d`/`r`.
2. **An icon on PRDs linked to a GH PR.** A card marker (the established marker
   family — liveness / suppressed / human-review) showing a PRD has an open PR, so the
   board distinguishes "done, no PR yet" from "done, PR open" at a glance.
3. **A `go to PR` keybind** that opens the attached PR in the browser, when one exists.

The hard part is the same one every overlay faces: **where does the PR link live?**
The board is a read-only viewer of files and Overseer-owned operational state, never a
GitHub client today. Nothing tracks a PR URL. Options, with the now-familiar trade:

- **A sidecar** keyed by PRD (like the liveness handle), recording `prd → pr-url`
  when `open PR` runs; the icon and `go to PR` read it. Keeps the watched root clean,
  matches the overlay pattern, but the link is Overseer-local (lost if you inspect from
  elsewhere).
- **Query GitHub live** (`gh pr list --head <feature-branch>`): no persistence, always
  truthful, the icon reflects reality even for a PR opened outside Overseer — but it
  adds a `gh` subprocess on the board's hot path (bound it like the liveness query) and
  a hard dependency on `gh` + auth + network.
- **PRD frontmatter** (`pr: <url>`): durable and portable, but it makes *something*
  write to the watched root for a PRD — and PRDs deliberately have **no** written
  fields today (status is derived, ADR 0003); adding a written field to `prd.md` is a
  real departure worth its own decision.

Open questions: does this assume a GitHub remote (the flow is `gh`-shaped — what about
non-GitHub repos)? Is the base always `main`, or configurable? Does opening the PR
change the PRD's board state at all, or is `done` still `done` with just an added icon?
Note this is the first time the board would *reach out to GitHub* rather than only read
local files — a genuine new capability class, like the deferred per-agent-logs
subprocess call, not a keybind on existing data.

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
  coexist with the alt-screen board that already *clips* on overflow (see "Viewport
  scrolling" below)? Live log tailing inside Ink is real UI work.
- **Overlaps "is it hung?".** The `state: working/idle/blocked` field liveness already
  captures is the *cheap* signal and may answer "what's it doing" 80% of the time; full
  logs are the *expensive* signal to reach for when `state` isn't enough.

So: a natural follow-on now that the liveness handle has landed, but its own UI-shaped
piece of work, not part of the dogfood-minimum set.

This is one of **three pane-shaped ideas** that all want the same missing surface — a
place to render per-Issue detail. See "View the Issue / PRD body" (next) for the shared
"design the detail pane once" framing.

### Bundle the `tdd` skill and hard-require it in the implementor prompt

Dispatched work must be test-driven, not test-optional. Today the implementor prompt
(`buildImplementorPrompt`) says nothing about tests — it leans entirely on the Issue body's
"Testing Decisions" to imply them, so an agent *may* write tests but is under no disciplined
test-first loop. The requirement: the implementor prompt **hard-requires the `tdd` skill**
(red-green-refactor) before parking the Issue at `ready-for-review`.

But naming a skill in the prompt is only safe if the skill is *guaranteed present* on the
machine the agent runs on. A dispatched `claude --bg` agent is a fresh session; if `tdd`
lives only in the operator's personal `~/.claude/skills`, the brief references a skill the
agent can't load. So this idea has two coupled halves:

1. **Bundle `tdd` with the app.** Overseer already ships skills — the four `overseer-*`
   skills live in `skills/` and `init` installs them into the target ([ADR 0004](./adr/0004-init-silently-overwrites-bundled-skills.md)).
   Add `tdd` to that bundled set so every Overseer install carries it, and the implementor
   prompt can reference it by name knowing it exists. (Decide where it installs — alongside
   the `overseer-*` skills, project-scoped — and whether ADR 0004's silent-overwrite
   behavior is right for a skill the operator might want to customize.)
2. **Reference it in the prompt.** Add a step to `buildImplementorPrompt` instructing the
   agent to drive the implementation with the `tdd` skill. Keep the template's
   pure/deterministic/auditable property (its docstring's whole point) — a static
   instruction preserves that.

Open question worth resolving when shaping this: is TDD a *global* mandate baked into the
prompt for every Issue, or a per-Issue choice the "Testing Decisions" should drive? The hard
requirement says global — but some Issues (a docs-only or config Issue) have nothing to
red-green. A global mandate is simplest and is the stated intent; note the docs/config
exception as a known wrinkle rather than building per-Issue opt-out up front.

### View the Issue / PRD body

Overseer reads every PRD/Issue markdown file but **never shows the body** — the board
renders only the title, badges, and markers. To read what an Issue actually *says* (its
`## What to build`, acceptance criteria, the PRD's problem statement) you have to open the
file outside the app. For a tool whose whole job is surfacing PRD/Issue work as a live
board, not being able to read the work from inside it is a real gap. The idea: a way to
view the selected card's full markdown body — its frontmatter-stripped content, ideally
lightly rendered (headings, lists, checkboxes) rather than raw.

Open questions: where it renders (a side/bottom **detail pane** vs. a full-screen modal vs.
expand-in-place), and how it scrolls given the alt-screen board already clips on overflow
(see "Viewport scrolling"). At the board level the body is the PRD's `prd.md`; zoomed, it
is the selected Issue's file — so one surface serves both levels.

**The shared detail surface.** Three ideas converge on the same unbuilt thing — a pane that
renders per-Issue/PRD detail:

1. **This one** — the Issue/PRD markdown body.
2. **"Per-agent logs from a card"** (above) — the selected agent's `claude logs` output.
3. **"A detail pane / expand-on-select"** (under "more real estate for Issue titles") — full
   title overflow + body + deviation reason for the selected card.

They are the same rendering surface viewed three ways (static body / live log stream /
overflow detail). Whoever shapes any one into a PRD should design the pane *once* — its
placement, scrolling, and how it shares the screen with the clipped board — rather than
inventing three. The body view is the simplest of the three (static text, no subprocess,
no live tailing), so it is the natural first cut that establishes the pane the other two
then reuse.

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

### Show the AI-review iteration count on an in-review card (e.g. `2/3`)

While an Issue is `in-review`, surface how many `/code-review` passes it has been
through and the cap before it escalates to a human — a `2/3`-style marker on the card.
It answers "is this review nearly out of road?" at a glance: a card at `1/3` is fresh,
one at `3/3` is about to either pass clean or land in `human-review` for
non-convergence.

The catch: **that count does not exist anywhere Overseer can read it today.** The
3-pass loop runs entirely *inside a single reviewer agent's session* — the reviewer
spawns once, loops `/code-review` up to 3 times in-process, and writes back only a
*terminal* status (`done`, or `human-review` with a reason like `non-convergence`).
The iteration number lives in the agent's head, never on the Issue file or a sidecar
(CONTEXT.md → Review outcome). So this is **not a rendering tweak** — it needs the
count *exposed* first. Two shapes for that, each with a cost:

- **The reviewer writes its progress to the Issue** (e.g. a `review_pass: 2`
  frontmatter field, updated each pass). Simplest to read, but it makes the reviewer
  write to the watched root *mid-loop* — today it writes only the one terminal edit,
  and per-pass writes would each fire a re-scan and add churn. Stays within ADR 0002
  (agents write, viewer reads) but increases write frequency.
- **The reviewer reports progress out-of-band** (a sidecar keyed by Issue, like the
  liveness handle), and the board overlays it like the other markers. Keeps the Issue
  file clean and matches the liveness/suppressed overlay pattern, but adds a second
  thing the reviewer must emit and the board must join.

Pairs tightly with "Configurable AI-review turns and effort" above: the moment the cap
is a `config.toml` knob, the denominator in `N/cap` must read that config, not a
hardcoded 3 — so if both are built, build them together (one source of truth for the
cap, consumed by the loop, the marker, and the config).

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

- **Who fixes?** If each reviewer only *reviews*, something else has to apply fixes
  between passes — re-dispatch the implementor? a dedicated fixer agent? That's a new
  loop edge, not just swapping the spawn.
- **State handoff.** A single session carries context across passes for free; separate
  agents need the findings/fixes passed between them (via the worktree commits, or an
  explicit handoff artifact). The worktree *is* the shared state, so a fresh reviewer
  reading the latest commit may be enough — worth confirming.
- **Cost & latency.** N spawns instead of 1 per Issue, each paying cold-start +
  worktree checkout. Wider fan-out against the same shared-checkout concerns dispatch
  already navigates.
- **Liveness/iteration tracking interacts.** Each pass becoming its own spawn means
  each has its own handle — which would actually make the iteration count (the `N/3`
  idea above) *naturally* visible as distinct spawns, rather than something the single
  agent must self-report. The two ideas reinforce each other.

This is a meaningful change to the review model (ADR 0005 territory — the review
reactor), not a prompt tweak; it deserves its own design pass on the review loop's
shape if pursued.

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
- **Surface the `d` dispatch keybind in the bottom row.** The bottom bar shows
  the `auto` indicator and the `? help` hint but not the primary action that
  ignites a PRD. `d` is discoverable only by opening the help modal, so a new
  user staring at a `backlog` PRD has no on-screen cue for how to start it. Add
  dispatch (and likely its siblings — `r` review, etc.) as a persistent hint in
  the bottom row so the ignition gesture is visible without `?`. Pairs naturally
  with the "Central keybind registry" idea below: a single registry could feed
  both the bottom-row hints and the help modal.

### Central keybind registry

Keybinds are hardcoded inline as `if (input === "…")` branches in `App.tsx`'s
`useInput`. The `?` help modal (UI Polish part 1) lists them as a **second hardcoded
copy**, guarded against drift only by a test. A future refactor would lift keybinds
into a single `{key, label, level}` registry that *both* the input handler and the
help modal consume, eliminating the drift risk — deferred from part 1 to avoid
dragging an input-architecture refactor into a polish pass.

### Fold the Unsorted column into backlog with a warning marker

The Issue-level board carries a leftmost **Unsorted** column for Issues with a
missing/unknown `status` (CONTEXT.md → Issue status). It is arguably a column too
many: an Unsorted Issue already derives to the **backlog lane** for PRD-status
purposes ("pre-in-progress" — it never promotes a PRD to in-progress and isn't
`done`, CONTEXT.md → PRD status), so the separate column splits one conceptual
"not started" lane across two visual columns. The idea: **drop the Unsorted column
and render those Issues inside `backlog`, flagged with a warning marker** (a card
marker like the human-review / liveness / suppressed ones — "this Issue's status is
missing or unrecognised; fix the frontmatter"). It would still be visible and still
demand attention — the marker is the attention signal — but the board would have one
fewer column and the "not started" cards would live together.

Open questions before committing: (1) does collapsing lose the *triage* signal that
a dedicated column gives (an Unsorted Issue is a data error to fix, not a deliberate
backlog parking — the column makes that loud); (2) does it muddy the clean "backlog =
deliberately not started yet" reading by mixing in malformed Issues; (3) whether the
derivation prose in CONTEXT.md simplifies or just moves (the lane logic already treats
Unsorted as pre-in-progress, so this is mostly a *rendering* change, not a derivation
one). Pairs with the existing marker family — it's the same "surface a card-level
condition as a marker instead of a structural column" move as the suppressed marker.

### Rework the selection-highlight design

The current selected-card treatment is `inverse` + `bold` on the title line plus a
prepended `▶ ` arrow (the `selected` branch in the Card component). Two problems:
(1) `inverse` (swapped fg/bg) reads as heavy and noisy, and fights the colored
markers — a selected card with a red `⊘ suppressed` or green `● live` line gets a
muddy mix of inverse-title + colored-marker; (2) the `▶ ` arrow *consumes two
columns of the title line itself*, so the one card you're focused on truncates its
title **two chars earlier** than its neighbours — actively worse legibility on the
card that matters most. That's the opposite of what selection should do.

Directions to weigh (not yet decided): move the selection signal off the title line
entirely so it costs the title no width — e.g. lean on the existing cyan
**border** (`borderColor` already flips to cyan on select) as the *sole* indicator
and drop both the inverse and the arrow; or a left **gutter** column outside the
card box that holds the `▶` so it never eats title width; or a background tint on
the whole card rather than an inverse title. Whatever wins, the constraint is: the
selected card must show *more* of its title than an unselected one, never less.

### Brainstorm: more real estate for Issue titles

Titles are cramped. A column is a hardcoded `width={24}`, and each card spends that
budget on a rounded border (−2) + horizontal padding (−2), the ready/liveness badge
glyph, and (when selected) the `▶ ` arrow (−2) — leaving a `truncate-end` title
often **~16 chars wide**. For Issue titles like "Share one failed-set across all
spawn edges" that's near-useless; you read the first two words and guess. Worth a
dedicated design pass, not a one-line tweak. Candidate directions to brainstorm:

- **Make column width adaptive, not fixed.** Divide the (full-screen, ADR-driven)
  viewport across the visible columns instead of pinning 24. On a wide terminal
  titles breathe; on a narrow one they degrade gracefully. Interacts with the
  clipping/overflow problem already noted under "Viewport scrolling".
- **Drop per-card chrome.** The rounded border + padding on *every* card is a heavy
  per-card tax on width and vertical space. A lighter separator (a rule, or just
  spacing) between cards could reclaim the 2 border + 2 padding columns for the
  title. Selection could then be the *only* thing that draws a box (ties into the
  highlight rework above).
- **Wrap instead of truncate.** Let a long title wrap to two lines (`wrap="wrap"` /
  truncate at line 2) rather than hard-truncating at one. Costs vertical space —
  trades against the overflow/clipping limit — but a title you can fully read may be
  worth a taller card. Possibly only for the *selected* card (expand-on-select).
- **A detail pane / expand-on-select.** Keep cards terse, but show the full title
  (and body, deviation reason, etc.) for the selected Issue in a side or bottom
  pane. The card list stays scannable; the focused Issue gets unlimited room. This
  is the biggest change and is one of the **three pane-shaped ideas** that share one
  detail surface — see the "shared detail surface" note under "View the Issue / PRD
  body" for the design-the-pane-once framing.

These two ideas are coupled: the `▶ ` arrow is both a highlight-design choice and a
title-width tax, so a selection rework and a real-estate pass should probably be
designed together rather than as separate polish bullets.

### Fix hjkl navigation to be relative to the board (2-D)

`hjkl` today is fake vim nav: `moveDelta` collapses all four keys into a 1-D ±1 step
over a flat card list — `h`/`k` both move −1, `j`/`l` both move +1 (the code comment
admits "treat horizontal moves the same as vertical"). So `h` and `k` are
indistinguishable, `j` and `l` are indistinguishable, and `l` does **not** move right
to the next column — it just steps to the next card in flat order. Navigation should
be **spatial, relative to the board's columns**: `l` → the card to the right (next
column), `h` → left (previous column), `j` → down within a column, `k` → up. That's
what a user pressing `l` on a kanban board expects.

This is **not a keybind tweak** — the nav reducer (`navReduce` / `NavState`) has no
concept of columns or rows. It models selection as a single flat index (`boardIndex`
/ `issueIndex`) and a single `move` action carrying a `delta` over a flat `count`.
Making `l`/`h` mean "change column" requires the nav model to become 2-D: track
*which column* and *which row within it*, and define the cross-column behavior. The
open design questions are the interesting part:

- **What does `l`/`h` do to the row?** Moving from a column with 5 cards (row 3) to
  one with 2 cards — clamp to the nearest row (row 1), or remember the original row
  and restore it if you come back? Vim-style "sticky column" (here, sticky *row*) is
  the nicer behavior but more state.
- **Empty columns.** `l` into an empty column — skip to the next non-empty one, or
  land on the empty column with no selection? A kanban routinely has empty columns
  (a PRD with nothing `in-review`), so this case is common, not edge.
- **Which levels.** Both the 7-column Issue level *and* the 3-column board level are
  grids, so both want 2-D nav — the reducer change covers both.
- **Arrow keys come along for free** once the model is 2-D (←/→ map to `h`/`l`,
  ↑/↓ to `j`/`k`), replacing today's arrow→flat-delta mapping.

Pairs with the "Central keybind registry" idea (this touches the same input layer)
and benefits from being designed alongside the selection-highlight rework, since both
are about how the *current* card is identified and moved.
