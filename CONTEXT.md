# Overseer

A TUI app that reads PRDs and issues from a configurable directory and renders them as a kanban board, live-updating as the underlying files change on disk.

## Language

**PRD**:
A document describing a single feature. The PRD _is_ the feature — there is no separate "feature" entity. Carries the issues that deliver the feature.
_Avoid_: Feature (as a distinct entity), spec, epic

**Issue**:
A unit of work that belongs to exactly one PRD. Rendered as a card on the kanban board.
_Avoid_: Ticket, task, card (card is the visual rendering of an Issue, not the Issue itself)

**Liveness**:
Whether the agent Overseer spawned for an Issue is still running. An *overlay* on the board, never a fact in the Issue files: derived from a **sidecar state file** outside the watched root (`~/.local/state/overseer/`, where `dispatch.log` already lives), keyed by Issue, recording each spawn's process handle. Keeps the viewer read-only ([ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)) — the PID is Overseer's operational state, not domain data, so it lives beside the failure log, not in the Issue.
_Avoid_: health, status (status is the Issue's kanban column; liveness is orthogonal to it)

**Orphan**:
An Issue stuck in an *active* status (`in-progress` / `in-review`) on disk whose agent is no longer alive — the agent crashed, was killed, or the board died mid-run after the status flip. Distinct from plain `unknown` [Liveness](#): an Orphan is an active-status Issue whose agent will never write the next status, so it is stuck forever, not merely unobserved. Overseer **flags** it with a card marker and offers a **one-keypress re-dispatch** (rolling the status back to its awaiting value so the normal spawn edge re-picks it up); it never rolls an orphan back automatically — the human is the safety check against a false-dead verdict.
_Avoid_: dead (an orphan may be flagged from a `unknown` verdict that is merely a query hiccup, not a confirmed death), stuck (too vague)

**Kill**:
Human-triggered termination of a *live* agent Overseer spawned, via `claude stop <handle>` against the handle recorded in the [Liveness](#) sidecar. Issue-level, gated on a `live` verdict (you can only stop a running agent Overseer recorded — an unrecorded or already-gone agent has no handle to pass). A Kill is **stop-only**: it halts the process and writes *nothing* to the Issue, so the Issue parks in its active status (`in-progress` / `in-review`) off the [Reactor](#reactor)'s frontiers — a **durable pause of one in-flight agent** the auto-run toggle cannot give (`a` only stops *new* spawns). The stopped agent then reads as an [Orphan](#) on the next scan, and recovery is the *existing* [Orphan](#) `R` flow — re-arming under auto-run restarts it. `claude stop` keeps the session (resumable via `claude attach`), so it is a suspend, not a destroy.
_Avoid_: terminate (too final — the session is kept), pause (pause is the unbuilt per-PRD idea; Kill stops one agent, not a PRD)

**Deviation**:
A record an implementor agent writes on its Issue — a `deviation` frontmatter field carrying the reason — when it strays from the Issue's planned approach to get the work done. The field's *presence* (not any boolean value) is the gate: a recorded Deviation forces a human review rather than an AI-only one. The implementor writes it in the same edit that flips the Issue to `ready-for-review`. See [Review outcome](#review-outcome).
_Avoid_: drift, divergence

**Suppressed**:
An Issue every spawn edge is deliberately skipping this session because a spawn on that edge *failed to launch*. On disk the Issue sits in an eligible `ready-*` status — the spawn edge rolled it back from its active status after the launch threw — so it looks dispatchable, but it is held in a session-scoped **failed-set** keyed by `(Issue, edge)` and subtracted from the frontier, so it will not retry until the board is **reopened** (the natural "I fixed my environment, try again" gesture; the set is ephemeral, [ADR 0007](./docs/adr/0007-auto-run-toggle-is-ephemeral.md)). The set is **shared across all three spawn triggers** — the [Reactor](#reactor)'s auto-spawn *and* the manual `d`/`r` edges all record into and subtract from it — so a failed launch is suppressed identically whoever triggered it; a manual `d` that fails to launch is just as visible (and just as un-retried) as an automated one. Like [Liveness](#), it is an **overlay** on the board, never a fact in the Issue file: the suppression is purely in-memory session state, joined onto the card after the read-only scan ([ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)). The card carries a `⊘ suppressed` marker (red — its own truncating line under the title, mirroring the [Liveness](#) / human-review marker treatment) that resolves the contradiction — *this card looks dispatchable but is being ignored; reopen to retry.* The red and the `⊘` ("no-go") deliberately set it apart from the yellow warning family ([Orphan](#), human-review reasons): those are *work-happened, needs-a-human* states, whereas suppressed is *nothing ran — a launch failed*, a different category the user resolves by fixing the environment and reopening, not by judging an agent's output. The marker is **lane-gated**: it renders only while the Issue is on its awaiting `ready-*` lane, so an Issue that leaves that lane (re-triaged, hand-edited, completed) drops the marker even though its failed-set entry lingers — the set is append-only within a session, but a stale entry is simply inert, never a false marker. The marker is **edge-agnostic**: a card sits in exactly one column, so its status already implies the edge (a `ready-for-agent` card can only be implementor-suppressed, a `ready-for-review` card only reviewer-suppressed), making the edge word redundant. "Suppressed" is the user-facing word as well as the internal one — unlike "reactor" (an invisible mechanism the user never names), it is a card state the user observes and acts on, like [Orphan](#)'s marker. The name is *trigger-neutral* on purpose: it names the state (a launch failed here, parked this session), not who triggered the failing spawn — the Reactor and the `d`/`r` keybinds all produce it.
_Avoid_: spawn-failed (that is the triggering *event*; suppression is its durable session-long consequence), stuck/blocked (overloaded — `blocked_by` is the unrelated dependency relation)

## Relationships

- A **PRD** has many **Issues**
- An **Issue** belongs to exactly one **PRD**

## On-disk layout

Folder-per-PRD. Each PRD is a directory under the configured root; its issues are files inside it.

```
<root>/
├── auth-system/
│   ├── prd.md
│   ├── issue-001.md
│   └── issue-002.md
└── billing/
    ├── prd.md
    └── issue-001.md
```

- A directory under `<root>` containing a `prd.md` file _is_ a **PRD**. A directory **without** a `prd.md` is ignored — not a PRD.
- An **Issue** is a file inside a PRD directory. It belongs to that PRD by virtue of where it lives.

### File contract

**PRD file** — `prd.md` in the PRD directory.
- Identity: the directory name (e.g. `auth-system`).
- Display title: `title` frontmatter, falling back to the directory name.
- Has **no `status` frontmatter field**. A PRD's status is **derived at read time** from its Issues, not stored — see [Issue status](#issue-status) and [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md). `prd.md` carries `title` and the body only.

**Issue file** — `NNN-slug.md`, e.g. `001-auth.md`, `002-password-reset.md`.
- Identity: the filename.
- The zero-padded `NNN-` prefix is the deliberate sort key for ordering within a column (filename-alpha). Order is incidental/positional, not priority. Within one column you may see gaps (`001`, `004`, `007`) because the other-numbered issues sit in other columns — relative order still holds.
- Display title: `title` frontmatter, falling back to the slug portion of the filename.
- `status` frontmatter as defined below.

## Config

A single TOML config file at `~/.config/overseer/config.toml` holding just the root directory:

```toml
root = "~/work/prds"
```

There is **one board**, pointed at one root. PRDs and Issues are **authored directly in the root** — they are not created inside code repos and synced in. The root is their native, only home, so Overseer is a pure viewer of one flat tree (no symlinks, no globbing across repos, no sync step). Although the underlying _work_ may span multiple code repos, the PRD/Issue files all live under this single root. No board-switching, no multiple named roots in v1. The 5 status columns are hardcoded (not config-driven) for v1.

## Live update

Overseer watches the root with OS-level filesystem events and a **~150ms debounce** to coalesce editor save-bursts (atomic-save renames, multi-event writes). On any debounced event it **re-scans the entire root and rebuilds the board model from scratch** — no incremental per-file patching, which sidesteps move/rename ambiguity. The tree is small (dozens–low-hundreds of markdown files) so a full re-scan is cheap.

**UI state (selected card, scroll position) is held separately from the board data**, so a re-scan/rebuild never loses the user's place.

## Issue status

The kanban columns, left to right. Status lives in each **Issue** file's YAML frontmatter. A **PRD has no stored status** — its column is derived from its Issues (see [PRD status](#prd-status-derived) below).

The Issue-level board has **7 columns**:

1. **backlog**
2. **ready**
3. **in-progress**
4. **ready-for-review**
5. **in-review**
6. **human-review**
7. **done**

**ready-for-review** and **in-review** are distinct: `ready-for-review` is "the implementor is done, but no reviewer has picked it up yet"; `in-review` is "a reviewer agent is actively reviewing it." The split mirrors the implementation handoff — see [Status lifecycle](#status-lifecycle).

**human-review** is the one column in the whole pipeline that requires a human's attention — an Issue lands here only when an AI review alone is not enough (see [Review outcome](#review-outcome)). Nothing auto-spawns on it; it is a queue a human works.

**ready** carries a substatus shown as a badge _on the card_, not as its own column:
- **ready-for-human**
- **ready-for-agent**

So the substatus is a property of the Issue, rendered as a badge within the single **ready** column.

### Status in frontmatter

Status is a single compound string field. The `ready` substatus is encoded as a suffix on the value:

```yaml
status: ready-for-agent   # or ready-for-human
```

Canonical values: `backlog`, `ready-for-human`, `ready-for-agent`, `in-progress`, `ready-for-review`, `in-review`, `human-review`, `done`.

- The board groups **exactly** `ready-for-human` and `ready-for-agent` into the single **ready** column; the suffix drives the card badge. ⚠️ This is an exact-value match, **not** a `ready-for-` prefix match — `ready-for-review` shares the prefix but is its *own* column, never folded into **ready**.
- Human/agent is a routing signal that only matters while **ready**. Once an Issue moves to `in-progress` it is just `in-progress` — the human/agent distinction is not tracked further.
- A missing or unrecognized status lands the Issue in a leftmost **Unsorted** column rather than being dropped.

### Status lifecycle {#status-lifecycle}

An Issue advances through two structurally identical **awaiting → active** handoffs, each owned by a trigger (a keybind, or the [Reactor](#reactor)) that flips the awaiting status to the active one *before* spawning an agent — the flip is the idempotency lock (see [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)):

| Phase | Awaiting (frontier) | Active | Agent |
| --- | --- | --- | --- |
| Implementation | `ready-for-agent` | `in-progress` | implementor |
| Review | `ready-for-review` | `in-review` | reviewer |

These are the **two — and only two — spawn edges.** Every other transition is either written by the spawned agent itself (`in-progress → ready-for-review` by the implementor; `in-review → done`/`human-review` by the reviewer) or is a deliberate human gate (`backlog → ready-*` authoring/triage; `human-review → done`). A trigger only ever exists on these two edges, because a trigger is precisely "flip an awaiting status, then spawn."

The implementor agent stops at **`ready-for-review`** (it does *not* write `in-review` — that refines [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md), which predates the column split). In the *same* edit that flips to `ready-for-review`, the implementor records its **worktree path and branch** on the Issue frontmatter (and a [Deviation](#deviation), if it strayed) — the review trigger flips `ready-for-review → in-review`, and the reviewer reads the worktree to check out and review, and the branch to merge. These are recorded, never derived: `claude --bg` worktree/branch names are random and uncontrollable (see [ADR 0006](./docs/adr/0006-issues-carry-their-worktree-and-branch.md)).

### Review outcome {#review-outcome}

Everything is **AI-reviewable by default**. A **human review** is required when *either*:

1. The implementor recorded a [Deviation](#deviation) — it strayed from the Issue's plan to complete the work.
2. The AI review could not converge — the reviewer loops `/code-review` at **medium** effort (fixing as it goes), where one iteration is a single `/code-review` pass plus its fixes and convergence is a pass that reports **zero** findings. After a hardcoded cap of **3** passes still finding issues, it escalates to a human. (The cap and effort are deliberately hardcoded for v1; making them configurable is in `docs/ideas.md`.)

Every Issue entering `in-review` gets the AI review loop **first**, regardless — a Deviation never skips it. The cleaned-up diff then takes one of two exits:

- **Clean AI pass, no Deviation** → the reviewer **attempts to merge the Issue's worktree into the PRD feature branch**. A clean merge sets `done`, fully unattended. A **merge conflict** escalates to `human-review` (the feature branch moved under a sibling worktree — expected to be *common* in parallel work, so never auto-resolved by an agent).
- **Deviation recorded, or AI couldn't converge** → `human-review` directly. No automatic merge.

So `human-review` is reached three ways: a recorded Deviation, AI non-convergence, or a merge conflict. The reviewer records *which* on the Issue as a **`human_review_reason`** frontmatter field (`deviation` / `non-convergence` / `conflict`) in the same edit that sets `human-review`, and the card surfaces it as a short marker — so a human sees what attention an escalated Issue needs before opening it. In every case a human resolves it, then **approves by running a bundled merge skill** that merges the worktree into the PRD feature branch and sets `done` — the *same* merge the clean-AI path runs automatically, just human-invoked. (This adds a fourth bundled skill alongside `grill-with-docs` / `to-prd` / `to-issues`, and a new status writer the read-only board reflects — consistent with [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)'s contract that any writer must respect the transitions.)

So a human only ever sees *better* code (AI cleaned it first), and the riskiest action — integration — is unattended only on the path an AI has certified clean. Merge targets the **PRD feature branch only**; merging that branch to `main` is out of scope for this flow.

"Awaiting human review" is its own **`human-review`** column (not a badge) — the single human-attention queue in the pipeline.

**The review flow is also what unblocks the dependency graph.** Blockers clear only on `done` (see [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)), and `done` was previously unreachable — which is why dispatch was "single-wave today." With review→merge→`done` in place, completing one Issue can unblock its siblings. The *re-dispatch* of those newly-unblocked Issues is still manual (`d`) until the reactor lands.

`human-review` has a **single exit: `done`**. There is no rework status and no bounce-back-to-agent path — once an Issue reaches `human-review` it belongs to the human until it is `done`. The human resolves whatever sent the Issue here *in place* (fixing by hand as needed within the worktree), then runs the merge skill. A rejected agent attempt is never re-dispatched.

### PRD status (derived) {#prd-status-derived}

A PRD has **no stored status** — `prd.md` carries no `status` field. The board **derives** a PRD's column at read time, during the same full re-scan it runs on every filesystem event ([ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md)):

- there is **≥ 1 Issue and every Issue is `done`** → **done**
- otherwise, **any Issue is `in-progress` or later** (`in-progress`, `ready-for-review`, `in-review`, `human-review`, `done`) → **in-progress**
- otherwise (all Issues `backlog`/`ready-*`/`Unsorted`, **or zero Issues**) → **backlog**

A freshly created PRD with no Issues is **backlog** — `done` requires at least one Issue, all done.

An **Unsorted** Issue (missing/unknown status) counts as **pre-in-progress**: it never promotes the PRD to in-progress, and — not being `done` — it blocks the all-done `done` derivation. So a PRD with `done` + `Unsorted` Issues derives to **in-progress**, not done: an unknown-status Issue can never silently advance *or* complete a PRD. (Derivation reads each Issue's resolved **lane**, so an Unsorted Issue is simply not in the in-progress-or-later set and not equal to `done`.) A PRD passes through only **backlog → in-progress → done**; it is never in `ready` or `in-review`, and — having no status field to be missing — is **never Unsorted**. Nobody writes PRD status: not the TUI, not the dispatcher (this reaffirms [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)).

## Reactor {#reactor}

The **Reactor** is the in-process automation that drives the pipeline forward without a human pressing a key for every wave. A human kicks a PRD off once with `d` ([dispatch](#interaction-v1)); from then on the Reactor takes over, auto-spawning agents on the two [spawn edges](#status-lifecycle) until the PRD's work is exhausted. It runs **in-process, only while the board is open** ([ADR 0005](./docs/adr/0005-review-reactor-runs-in-process-only.md)), and is **global** — one Reactor drives every PRD, not per-PRD.

"Reactor" is the *mechanism* — an internal term. The user-facing name for its on/off state is **auto-run** (see [Auto-run](#auto-run)); UI strings say "auto-run," never "reactor."

**What it spawns.** On the same two edges a keybind drives — never a third:
- **Implementor** for any `ready-for-agent` Issue whose `blocked_by` blockers are all `done` (the re-dispatch the [Review outcome](#review-outcome) was building toward — completing one Issue unblocks its siblings).
- **Reviewer** for any `ready-for-review` Issue (the auto-review that `r` does by hand).

**Level-triggered, no transition detection.** The Reactor is a step appended to the existing watcher → debounce → full re-scan callback ([Live update](#live-update)): after each rebuild it **reconciles** both frontiers and spawns whatever is eligible *right now*, reading only the on-disk status — never diffing, never tracking "what changed." It needs no transition detection because the same level-triggered model the board uses applies: an Issue is eligible iff its status (and its blockers' statuses) say so. The Reactor **feeds itself** — a spawn (or an agent finishing) writes a status to disk, which fires another re-scan, which reconciles again — so one `d` cascades through the whole dependency graph with no timer and no polling.

**Idempotency: flip before spawn.** Exactly as the keybinds do, the Reactor flips the awaiting status to the active one (`ready-for-agent → in-progress`, `ready-for-review → in-review`) *before* spawning. The flip is the lock: the moment it lands the Issue leaves the frontier, so overlapping reconcile passes can never spawn the same Issue twice. A **re-entrancy guard** (skip a reconcile while one is already running) is added for clean logs, not correctness — the flip already guarantees no double-spawn.

**No spawn cap.** Total spawns are bounded by the PRD's Issue count — every spawn consumes the `ready-*` status that made the Issue eligible, and flip-before-spawn prevents re-pickup, so there is no cycle that re-spawns an Issue. Burst width (a wide PRD fanning out many agents at once) is identical to what `d` already produces and is accepted, not capped ([ADR 0005](./docs/adr/0005-review-reactor-runs-in-process-only.md)).

**Terminal failure: rollback + session suppression.** When a spawn *fails to launch* (transient: bad binary, git hiccup, FS race), the status rolls back to its awaiting value — the same best-effort rollback the keybinds do — and the failure is appended to the durable log. To stop the level-triggered loop from immediately re-picking-up the rolled-back Issue and retrying forever, the Reactor holds an **in-memory failed-set, keyed by `(Issue, edge)`**, and subtracts it from each frontier. The set is **session-scoped**: closing and re-opening the board clears it and retries — accepted, because these failures are transient and re-opening is the natural "I fixed my environment, try again" gesture. A genuinely permanent failure therefore re-attempts once per session, bounded and logged. A spawn failure is **never** routed to `human-review` — that queue is for Issues where *work happened and needs human judgment* ([Review outcome](#review-outcome)), not for launches that never started; routing failures there would resurrect the rejected rework path.

**Visibility.** The Reactor's *internal* state is **visually invisible** — the live board tells the story through cards moving on their own, and all diagnostics (spawn failures, suppression) go to the durable failure log. The one exception is the [auto-run](#auto-run) on/off state, which carries a persistent indicator (an idle on-Reactor and an off-Reactor both leave the board still, so the off state *must* be legible). Surfacing the finer Reactor state in the UI (e.g. a marker on a suppressed Issue) is a future idea.

### Auto-run {#auto-run}

**Auto-run** is the user-facing on/off switch for the Reactor. On (the default), the Reactor reconciles after every board rebuild as described above; off, `reconcile()` early-returns and no agents auto-spawn — the user drives the pipeline by hand with `d`/`r`. It exists to brake a runaway wave or step through dispatch manually.

- **Global, one switch.** It toggles the whole Reactor, not a single PRD (a per-PRD pause is a separate, unbuilt idea in `docs/ideas.md`).
- **Stops *new* spawns, not running agents.** Toggling auto-run off stops the Reactor starting more agents; the ones already running keep going. To stop a single in-flight agent, [Kill](#) it (`K`) — that is the durable per-agent pause auto-run cannot give.
- **Keybind `a`**, at both board *and* Issue level — a global switch should be reachable wherever you are, unlike the level-scoped `d`/`r`. Suppressed while a modal is open.
- **In-memory, on by default, dies on quit.** Auto-run state is *not* persisted — reopening the board starts it on again. This is deliberate: it keeps the Reactor's stateless, level-triggered resume free, treating auto-run like selection/scroll (live session state, not config). See [ADR 0007](./docs/adr/0007-auto-run-toggle-is-ephemeral.md).
- **Re-enabling catches up.** Turning auto-run back on immediately reconciles, so the board acts on everything that became eligible while it was off rather than waiting for the next filesystem event.
- **Persistent indicator.** A status line shows `▶ auto-run on` / `⏸ auto-run off` at all times, so a still board is never ambiguous between "braked" and "finished."

## View

Two kanban levels with **different column sets**:

- **Board level** — the cards are **PRDs**. The board collapses to **3 columns — backlog / in-progress / done** — each PRD in its [derived](#prd-status-derived) column. A PRD is never Unsorted (no status field to be missing). This is the default/top view.
- **PRD level (zoom)** — selecting a PRD zooms into a kanban whose cards are that PRD's **Issues**, across the full **7 columns** (plus a leftmost **Unsorted** column for Issues with missing/unknown status).

The **ready** column and its 🧑/🤖 badge (`ready-for-human` / `ready-for-agent`) exist at **Issue level only** — the board level has no `ready` column. Within a column, cards order by the issue filename's `NNN-` prefix (incidental, not priority).

Overseer is a **read-only viewer** — it never writes the PRD/Issue files; editing happens elsewhere and Overseer reflects the changes live.

### Interaction (v1)

- `hjkl` / arrows — move card selection.
- `Enter` — zoom from a selected PRD into its Issue-level kanban.
- `Esc` — back out from PRD level to board level.
- `q` — quit (backs out to board level first if zoomed).
- `d` — **dispatch**, at *board level*: spawns an implementor for every eligible Issue in the selected PRD (a whole wave at once).
- `r` — **review**, at *Issue level* (zoom): spawns a reviewer for the single selected `ready-for-review` Issue. Deliberately per-Issue, not per-PRD like `d` — dispatch fires a wave, but review is a deliberate act on one Issue's own worktree.
- `K` — **[kill](#)** the selected Issue's *live* agent, at *Issue level* (zoom): `claude stop`s the recorded handle (confirmation preview, mirroring `R`). Gated on a `live` [liveness](#) verdict; stop-only (writes no status), so the Issue then orphans and `R` recovers it. Deliberately shift-keyed like `R` — a rare, heavy action, distinct from `k` (move-up).
- `a` — toggle **[auto-run](#auto-run)** on/off, at *either* level: the global switch for the Reactor's auto-spawning. Unlike `d`/`r` it is not level-scoped (it acts on nothing under the cursor — it's a global switch).
- `?` — show a **keybind reference** modal, at *either* level: a passive full-screen card listing every keybind with its context. Dismissed by `?`/`Esc` (`q` closes it and quits). Suppressed while a dispatch/review preview is open (at most one modal on screen). A persistent `? help` hint on the status line keeps it discoverable.
- **No issue detail/body view in v1** — cards show title + status badge only. Reading an Issue's markdown body is a fast-follow.

The board renders **full screen** on the terminal's alternate screen buffer (like vim/htop), sized to fill the viewport with the status line pinned to the bottom row, and restores the prior shell contents on quit. The alt screen has no scrollback, so content exceeding the viewport **clips** — in-app scrolling is a logged follow-up (`docs/ideas.md`).

## Stack

Ink + TypeScript (React-for-the-terminal). See [ADR 0001](./docs/adr/0001-ink-typescript-tui.md). Watcher: `chokidar`; frontmatter: `gray-matter`; config: a TOML parser; future agent-spawning: `@anthropic-ai/claude-agent-sdk`.

## Future scope (not v1)

- Keyboard shortcuts to **spawn Claude agent instances** from the board (the capability that drove the stack choice — agents managed in-process via the TS Agent SDK).
- **Markdown viewing** of Issue (and PRD) bodies in a detail pane.

## Flagged ambiguities

- "Feature" vs "PRD" — resolved: a PRD _is_ a feature. One concept, canonical term is **PRD**.
- PRD status — resolved (reversed): a PRD has **no stored status**. Its board column is **derived at read time** from its Issues, and the board level collapses to backlog/in-progress/done. See [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md). (Earlier drafts gave a PRD an authored 5-value `status` maintained on top of the issues — that is superseded.)
