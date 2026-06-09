# Overseer

A TUI app that reads PRDs and issues from a configurable directory and renders them as a kanban board, live-updating as the underlying files change on disk.

## Language

**PRD**:
A document describing a single feature. The PRD _is_ the feature — there is no separate "feature" entity. Carries the issues that deliver the feature.
_Avoid_: Feature (as a distinct entity), spec, epic

**Issue**:
A unit of work that belongs to exactly one PRD. Rendered as a card on the kanban board.
_Avoid_: Ticket, task, card (card is the visual rendering of an Issue, not the Issue itself)

**Deviation**:
A record an implementor agent writes on its Issue — a `deviation` frontmatter field carrying the reason — when it strays from the Issue's planned approach to get the work done. The field's *presence* (not any boolean value) is the gate: a recorded Deviation forces a human review rather than an AI-only one. The implementor writes it in the same edit that flips the Issue to `ready-for-review`. See [Review outcome](#review-outcome).
_Avoid_: drift, divergence

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

An Issue advances through two structurally identical **awaiting → active** handoffs, each owned by a trigger (a keybind today; optionally the reactor later) that flips the awaiting status to the active one *before* spawning an agent — the flip is the idempotency lock (see [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)):

| Phase | Awaiting (frontier) | Active | Agent |
| --- | --- | --- | --- |
| Implementation | `ready-for-agent` | `in-progress` | implementor |
| Review | `ready-for-review` | `in-review` | reviewer |

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

`human-review` has a **single exit: `done`**. There is no rework status and no bounce-back-to-agent path in v1 — the human resolves whatever sent the Issue here *in place* (fixing by hand as needed within the worktree), then runs the merge skill. A rejected agent attempt is never re-dispatched; the human finishes it. (A "rework → `ready-for-agent`" path is a possible fast-follow once the manual version's friction is felt.)

### PRD status (derived) {#prd-status-derived}

A PRD has **no stored status** — `prd.md` carries no `status` field. The board **derives** a PRD's column at read time, during the same full re-scan it runs on every filesystem event ([ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md)):

- there is **≥ 1 Issue and every Issue is `done`** → **done**
- otherwise, **any Issue is `in-progress` or later** (`in-progress`, `ready-for-review`, `in-review`, `human-review`, `done`) → **in-progress**
- otherwise (all Issues `backlog`/`ready-*`, **or zero Issues**) → **backlog**

A freshly created PRD with no Issues is **backlog** — `done` requires at least one Issue, all done. A PRD passes through only **backlog → in-progress → done**; it is never in `ready` or `in-review`, and — having no status field to be missing — is **never Unsorted**. Nobody writes PRD status: not the TUI, not the dispatcher (this reaffirms [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)).

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
- **No issue detail/body view in v1** — cards show title + status badge only. Reading an Issue's markdown body is a fast-follow.

## Stack

Ink + TypeScript (React-for-the-terminal). See [ADR 0001](./docs/adr/0001-ink-typescript-tui.md). Watcher: `chokidar`; frontmatter: `gray-matter`; config: a TOML parser; future agent-spawning: `@anthropic-ai/claude-agent-sdk`.

## Future scope (not v1)

- Keyboard shortcuts to **spawn Claude agent instances** from the board (the capability that drove the stack choice — agents managed in-process via the TS Agent SDK).
- **Markdown viewing** of Issue (and PRD) bodies in a detail pane.

## Flagged ambiguities

- "Feature" vs "PRD" — resolved: a PRD _is_ a feature. One concept, canonical term is **PRD**.
- PRD status — resolved (reversed): a PRD has **no stored status**. Its board column is **derived at read time** from its Issues, and the board level collapses to backlog/in-progress/done. See [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md). (Earlier drafts gave a PRD an authored 5-value `status` maintained on top of the issues — that is superseded.)
