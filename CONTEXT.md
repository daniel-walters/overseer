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

**Open PR**:
The human, board-level act of opening a GitHub pull request for a `done` [PRD](#) — the closing move the pipeline otherwise stops short of. The whole review→merge flow lands a PRD's work on its **PRD feature branch** and explicitly leaves merging that branch to the repo's default branch [out of scope](#review-outcome); a `done` PRD is therefore a feature branch sitting unmerged, with no PR. **Open PR** is the `done`-gated keybind (sibling to `d`/`r`, behind a confirm preview) that closes the gap: it **pushes the feature branch** to the remote *then* opens a PR from it into the repo's resolved default base ([`defaultBase`](#), the same base the branch was created from) — two outward writes, both shown in the confirm preview. It is the board's **first reach-out to GitHub** (via `gh`): every other board action reads local files or Overseer-owned state. The agent never opens PRs (the implementor prompt forbids it) — this is the deliberate human gate. **Single-repo PRDs only** in v1: a PRD's feature branch is per-repo, so a PRD whose Issues span repos needs one PR per repo; that case is refused with a visible message (deferred, see `docs/ideas.md`). A GitHub remote is assumed; a `gh` failure (no auth, network, non-GitHub remote) surfaces loudly in the status line like a spawn failure. Once opened, the PR is surfaced as a [Linked PR](#) overlay — opening it **never** changes the PRD's derived status ([ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md)): `done` stays `done`.
_Avoid_: merge (the PR is opened, not merged — merging to the default branch stays the human's call on GitHub), publish

**Linked PR**:
The overlay that surfaces whether a `done` [PRD](#) has a GitHub PR, and its state. **Not stored anywhere** — the board derives it by querying `gh` live for the PRD's derived feature branch on each scan ([ADR 0013](./docs/adr/0013-linked-pr-is-a-live-gh-query-not-stored-state.md)), exactly as [Liveness](#) queries `claude agents`: no sidecar, no `prd.md` field (which would break [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md) and go stale the moment the PR merges). The query is bounded per scan behind an injectable seam (mirroring the dispatch `GitSeam`). It drives a **three-state** card marker — *no PR* (no marker), *PR open*, *PR merged* (the real end-of-lifecycle signal: the only thing that says the out-of-scope default-branch merge finally happened) — and the **`go to PR`** keybind, which opens the PR in the browser for both open and merged PRs. Because the link is live, [Open PR](#) refuses if a PR already exists (open or merged) for the branch — no double-PR — and the marker reflects reality even for a PR opened, merged, or closed outside Overseer.
_Avoid_: PR sidecar / `pr:` field (there is none — the link is queried, never stored), attached PR (nothing is attached; it is derived)

**Delete PRD**:
The human, board-level act of removing a `done` [PRD](#) — its `prd.md`, every [Issue](#) file, and the PRD directory itself — once its work is over and the card is just clutter. It is the board's **first destructive write to the watched root**: every other write is a status flip on an Issue file ([`writeStatus`](#status-lifecycle)) or an agent writing its own file, never a *removal* of domain data — so this is a deliberate, recorded exception to the read-only-viewer contract ([ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md), [ADR 0016](./docs/adr/0016-delete-done-prd-is-the-boards-first-destructive-root-write.md)). It is a **board-level, `done`-gated keybind** (`X`, sibling to [Open PR](#)'s board-level gate), behind a **confirm preview** — the single safety net, because the root is **not a git repo** (CONTEXT.md → Config), so a delete is **unrecoverable**: no `git restore`, no archive. The unit is the **whole directory**, removed wholesale (`rm -rf <prd-dir>`) — including any non-Issue files dropped in it — never a selective sweep that would leave a husk directory the layout rules no longer recognise as a PRD. It deletes **only the folder**: the PRD's Issues keep their [Liveness](#) **sidecar** entries (`~/.local/state/overseer/`), which go **dangling but inert** — the sidecar is only ever read as a join onto *scanned* Issues, so an entry for a vanished Issue is never looked up, exactly as the [Suppressed](#) failed-set tolerates stale entries. Reaping those dangling entries is a separate housekeeping concern (deferred, `docs/ideas.md`), not the delete keybind's job. Deleting **the files** does **not** touch the **work**: a `done` PRD's code lives on its [PRD feature branch](#status-lifecycle) (and any [Linked PR](#)); the delete removes the *record of intent*, not the branch. The gate is `done`-**only** (the same column [Open PR](#) gates on) — deliberately **not** also "PR merged," so a `done` PRD whose branch was abandoned (and will never merge) is still tidyable; the confirm is where the human owns the "is this safe to lose?" judgment. The rendering side is **free**: once the folder is gone the watcher's debounced re-scan ([Live update](#live-update)) rebuilds the board without it, the same path that already tolerates a folder vanishing out-of-band.
_Avoid_: archive (there is no trash/restore — it is a hard delete), remove (too soft for an irreversible destructive write), purge

**Eligibility**:
Whether an action keybind can act on the **current selection right now** — a per-binding predicate over the selected card's live state, distinct from the static **level** gate (board / issues). The level gate asks *"does this key work at this zoom?"*; eligibility asks *"given the selected card, would pressing it do anything?"*. A key is eligible only when its action has real work: `d` when the selected PRD's dispatch **frontier** has ≥1 spawn candidate (an unblocked `ready-for-agent` Issue — so `d` lights up on a *backlog* PRD to ignite **and** on an *in-progress* PRD to **resume** stalled work the [Reactor](#reactor) would otherwise own, which is the manual re-dispatch crank when [auto-run](#auto-run) is off); [Open PR](#) when the PRD is `done` and has no [Linked PR](#) yet; `go to PR` when the PRD is `done` and a [Linked PR](#) exists (so `P` and `go to PR` are mutually exclusive on a `done` PRD); [Delete PRD](#delete-prd) when the PRD is `done`; `r` when the Issue is `ready-for-review`; `R` when the Issue is an [Orphan](#); `K` when the Issue is `live`; `v` when any card is selected. The movement / zoom / `Esc` / `a` / `?` / `q` keys carry no eligibility gate beyond their level. Eligibility drives **all three** keybind surfaces from one truth: the input matcher (an ineligible key is genuinely **inert**, not a silent no-op), and the **[status-line hints](#interaction-v1)** (an ineligible key is **hidden**, so the hints show only what is actionable now). The `?` **keybind reference** is the deliberate exception — it always lists the **whole map** regardless of eligibility, because it answers *"what keys exist and where?"*, a learning surface, not *"what can I do right now?"*. The App computes eligibility from state it already reads for the handlers' guards (the frontier, the liveness verdict, the Linked-PR query) and the registry routes it — the registry stays a pure router, never reaching into seams itself.
_Avoid_: enabled/disabled (overloaded — `auto-run` is the on/off "enabled"; eligibility is per-key, per-selection), available

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
- A missing or unrecognized status folds the Issue into the **backlog** column rather than being dropped, carrying a loud **`⚠ bad status`** card marker (the "status is missing or unrecognised; fix the frontmatter" signal). There is no separate Unsorted column: a malformed Issue already derives to the backlog lane for [PRD status](#prd-status-derived) purposes, so a marker keeps the data error triageable without splitting "not started" across two visual columns. The marker sits in the yellow "needs a human" warning family alongside [Orphan](#) and the human-review reasons — distinct from a plain backlog card, and from the red `⊘ suppressed` "nothing ran" marker.

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
2. The AI review could not converge — the reviewer loops `/code-review` at the configured effort (default **medium**, fixing as it goes), where one iteration is a single `/code-review` pass plus its fixes and convergence is a pass that reports **zero** findings. After a configurable cap (`config.review.cap`, default **3**) of passes still finding issues, it escalates to a human. (The cap and effort are knobs in the `[review]` TOML table — `config.review.cap` / `config.review.effort` — not hardcoded.)

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
- otherwise (all Issues `backlog`/`ready-*`/malformed-status, **or zero Issues**) → **backlog**

A freshly created PRD with no Issues is **backlog** — `done` requires at least one Issue, all done.

A **malformed-status** Issue (missing/unknown status) folds into the **backlog** lane, so it counts as **pre-in-progress**: it never promotes the PRD to in-progress, and — its lane not being `done` — it blocks the all-done `done` derivation. So a PRD with `done` + malformed-status Issues derives to **in-progress**, not done: an unknown-status Issue can never silently advance *or* complete a PRD. (Derivation reads each Issue's resolved **lane**, and a malformed Issue's lane is `backlog` — simply not in the in-progress-or-later set and not equal to `done`, exactly as the retired Unsorted lane behaved.) A PRD passes through only **backlog → in-progress → done**; it is never in `ready` or `in-review`, and — having no status field to be missing — is **never malformed**. Nobody writes PRD status: not the TUI, not the dispatcher (this reaffirms [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)).

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

**Visibility.** The Reactor's *internal* state was originally **visually invisible** — the live board told the story through cards moving on their own, and all diagnostics went to the durable failure log. That invisibility produced healthy-looking cards that were actually being ignored, so the finer state is now **surfaced as overlays** on the board (always derived from in-memory Reactor state, never written to the watched root — [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)). Three signals now make the Reactor legible:

- The [auto-run](#auto-run) **on/off** state carries a persistent status-line indicator (an idle on-Reactor and an off-Reactor both leave the board still, so the off state *must* be legible).
- A **[Suppressed](#) per-card marker** (`⊘ suppressed`, [ADR 0011](./docs/adr/0011-suppressed-overlay-sources-from-in-memory-reactor-state.md)) flags a card the failed-set is silently subtracting from the frontier — *this card looks dispatchable but is being ignored*. This includes the **orphan re-dispatch that fails to launch**: an [Orphan](#) rolled back by `R` and re-picked-up by the spawn edge whose relaunch then throws lands in the same failed-set as any other launch failure, so it carries the same marker — a failed recovery is no longer invisible.
- A board-level **activity signal** — `⚙ working` / `… idle` / `□ at-rest` — on the status line beside the auto-run indicator, derived from the Reactor's in-memory state (whether auto-run is on, and whether the most recent reconcile spawned). It is **distinct** from auto-run on/off: auto-run answers *"is the brake released?"*, activity answers *"given that, is the Reactor moving?"*. **at-rest** is auto-run off (quiesced); **working** is auto-run on with the last reconcile spawning; **idle** is auto-run on with nothing eligible — so a still board is never ambiguous between *braked*, *busy*, and *nothing to do*. See [ADR 0012](./docs/adr/0012-reactor-activity-signal-derived-from-in-memory-state.md).

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

- **Board level** — the cards are **PRDs**. The board collapses to **3 columns — backlog / in-progress / done** — each PRD in its [derived](#prd-status-derived) column. A PRD is never malformed (no status field to be missing). This is the default/top view.
- **PRD level (zoom)** — selecting a PRD zooms into a kanban whose cards are that PRD's **Issues**, across the full **7 columns**. There is no Unsorted column: an Issue with a missing/unknown status folds into **backlog** carrying the `⚠ bad status` marker.

The **ready** column and its 🧑/🤖 badge (`ready-for-human` / `ready-for-agent`) exist at **Issue level only** — the board level has no `ready` column. Within a column, cards order by the issue filename's `NNN-` prefix (incidental, not priority).

Overseer is a **read-only viewer** — it never writes the PRD/Issue files; editing happens elsewhere and Overseer reflects the changes live.

### Interaction (v1)

- `hjkl` / arrows — move card selection.
- `Enter` — zoom from a selected PRD into its Issue-level kanban.
- `Esc` — back out from PRD level to board level.
- `q` — quit (backs out to board level first if zoomed).
- `d` — **dispatch**, at *board level*: spawns an implementor for every eligible Issue in the selected PRD (a whole wave at once). [Eligible](#) only when the selected PRD's frontier has a spawn candidate, so it is **inert and hidden** on a PRD with no dispatchable work. Its status-line hint reads **"dispatch"** on a `backlog` PRD (ignition) and **"resume"** on an `in-progress` one (re-dispatching newly-unblocked work — the manual crank when [auto-run](#auto-run) is off); the label is context-aware on the hint only, not in `?` help.
- `r` — **review**, at *Issue level* (zoom): spawns a reviewer for the single selected `ready-for-review` Issue. Deliberately per-Issue, not per-PRD like `d` — dispatch fires a wave, but review is a deliberate act on one Issue's own worktree.
- `K` — **[kill](#)** the selected Issue's *live* agent, at *Issue level* (zoom): `claude stop`s the recorded handle (confirmation preview, mirroring `R`). Gated on a `live` [liveness](#) verdict; stop-only (writes no status), so the Issue then orphans and `R` recovers it. Deliberately shift-keyed like `R` — a rare, heavy action, distinct from `k` (move-up).
- `X` — **[delete](#delete-prd)** the selected `done` PRD, at *board level*: removes the whole PRD directory (`prd.md` + every Issue file) wholesale, behind a confirm preview. `done`-gated (sibling to [Open PR](#)); the board's first destructive write to the root, so it is shift-keyed into the heavy family (`K`/`R`/`X`) and never bare. Irreversible (no git in the root), so the confirm is the safety net.
- `a` — toggle **[auto-run](#auto-run)** on/off, at *either* level: the global switch for the Reactor's auto-spawning. Unlike `d`/`r` it is not level-scoped (it acts on nothing under the cursor — it's a global switch).
- `?` — show a **keybind reference** modal, at *either* level: a passive full-screen card listing every keybind with its context. Dismissed by `?`/`Esc` (`q` closes it and quits). Suppressed while a dispatch/review preview is open (at most one modal on screen). A persistent `? help` hint on the status line keeps it discoverable. Deliberately the **[eligibility](#) exception**: it lists the *whole* map regardless of the current selection (a learning surface — *what keys exist?* — not *what can I do now?*), so it never hides a key that is merely ineligible right now.
- **No issue detail/body view in v1** — cards show title + status badge only. Reading an Issue's markdown body is a fast-follow.

The action keybinds are **[eligibility](#)-gated**, driven from a single per-binding predicate over the current selection: an ineligible key is genuinely **inert** (the input matcher does not fire it) *and* **hidden from the status-line hints**, so the hints surface only what is actionable on the selected card right now — `d`/`P`/`go to PR`/`X` appear or vanish as the selection moves across PRDs, `r`/`R`/`K` as it moves across Issues. The `?` reference is the lone exception (above). This is a single source of truth across all three surfaces — matcher, hints, and the help map's completeness — extending the keybind registry that already single-sources the map.

The board renders **full screen** on the terminal's alternate screen buffer (like vim/htop), sized to fill the viewport with the status line pinned to the bottom row, and restores the prior shell contents on quit. The alt screen has no scrollback, so content exceeding the viewport **clips** — in-app scrolling is a logged follow-up (`docs/ideas.md`).

## Stack

Ink + TypeScript (React-for-the-terminal). See [ADR 0001](./docs/adr/0001-ink-typescript-tui.md). Watcher: `chokidar`; frontmatter: `gray-matter`; config: a TOML parser; future agent-spawning: `@anthropic-ai/claude-agent-sdk`.

## Future scope (not v1)

- Keyboard shortcuts to **spawn Claude agent instances** from the board (the capability that drove the stack choice — agents managed in-process via the TS Agent SDK).
- **Markdown viewing** of Issue (and PRD) bodies in a detail pane.

## Flagged ambiguities

- "Feature" vs "PRD" — resolved: a PRD _is_ a feature. One concept, canonical term is **PRD**.
- PRD status — resolved (reversed): a PRD has **no stored status**. Its board column is **derived at read time** from its Issues, and the board level collapses to backlog/in-progress/done. See [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md). (Earlier drafts gave a PRD an authored 5-value `status` maintained on top of the issues — that is superseded.)
