# Overseer

A TUI app that reads PRDs and issues from a configurable directory and renders them as a kanban board, live-updating as the underlying files change on disk.

## Language

**PRD**:
A document describing a single feature. The PRD _is_ the feature — there is no separate "feature" entity. Carries the issues that deliver the feature.
_Avoid_: Feature (as a distinct entity), spec, epic

**Issue**:
A unit of work that belongs to exactly one PRD. Rendered as a card on the kanban board.
_Avoid_: Ticket, task, card (card is the visual rendering of an Issue, not the Issue itself)

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

The Issue-level board has **5 columns**:

1. **backlog**
2. **ready**
3. **in-progress**
4. **in-review**
5. **done**

**ready** carries a substatus shown as a badge _on the card_, not as its own column:
- **ready-for-human**
- **ready-for-agent**

So the substatus is a property of the Issue, rendered as a badge within the single **ready** column.

### Status in frontmatter

Status is a single compound string field. The `ready` substatus is encoded as a suffix on the value:

```yaml
status: ready-for-agent   # or ready-for-human
```

Canonical values: `backlog`, `ready-for-human`, `ready-for-agent`, `in-progress`, `in-review`, `done`.

- The board groups `ready-for-*` into the single **ready** column; the suffix drives the card badge.
- Human/agent is a routing signal that only matters while **ready**. Once an Issue moves to `in-progress` it is just `in-progress` — the human/agent distinction is not tracked further.
- A missing or unrecognized status lands the Issue in a leftmost **Unsorted** column rather than being dropped.

### PRD status (derived) {#prd-status-derived}

A PRD has **no stored status** — `prd.md` carries no `status` field. The board **derives** a PRD's column at read time, during the same full re-scan it runs on every filesystem event ([ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md)):

- there is **≥ 1 Issue and every Issue is `done`** → **done**
- otherwise, **any Issue is `in-progress` or later** (`in-progress`, `in-review`, `done`) → **in-progress**
- otherwise (all Issues `backlog`/`ready-*`, **or zero Issues**) → **backlog**

A freshly created PRD with no Issues is **backlog** — `done` requires at least one Issue, all done. A PRD passes through only **backlog → in-progress → done**; it is never in `ready` or `in-review`, and — having no status field to be missing — is **never Unsorted**. Nobody writes PRD status: not the TUI, not the dispatcher (this reaffirms [ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)).

## View

Two kanban levels with **different column sets**:

- **Board level** — the cards are **PRDs**. The board collapses to **3 columns — backlog / in-progress / done** — each PRD in its [derived](#prd-status-derived) column. A PRD is never Unsorted (no status field to be missing). This is the default/top view.
- **PRD level (zoom)** — selecting a PRD zooms into a kanban whose cards are that PRD's **Issues**, across the full **5 columns** (plus a leftmost **Unsorted** column for Issues with missing/unknown status).

The **ready** column and its 🧑/🤖 badge (`ready-for-human` / `ready-for-agent`) exist at **Issue level only** — the board level has no `ready` column. Within a column, cards order by the issue filename's `NNN-` prefix (incidental, not priority).

Overseer is a **read-only viewer** — it never writes the PRD/Issue files; editing happens elsewhere and Overseer reflects the changes live.

### Interaction (v1)

- `hjkl` / arrows — move card selection.
- `Enter` — zoom from a selected PRD into its Issue-level kanban.
- `Esc` — back out from PRD level to board level.
- `q` — quit (backs out to board level first if zoomed).
- **No issue detail/body view in v1** — cards show title + status badge only. Reading an Issue's markdown body is a fast-follow.

## Stack

Ink + TypeScript (React-for-the-terminal). See [ADR 0001](./docs/adr/0001-ink-typescript-tui.md). Watcher: `chokidar`; frontmatter: `gray-matter`; config: a TOML parser; future agent-spawning: `@anthropic-ai/claude-agent-sdk`.

## Future scope (not v1)

- Keyboard shortcuts to **spawn Claude agent instances** from the board (the capability that drove the stack choice — agents managed in-process via the TS Agent SDK).
- **Markdown viewing** of Issue (and PRD) bodies in a detail pane.

## Flagged ambiguities

- "Feature" vs "PRD" — resolved: a PRD _is_ a feature. One concept, canonical term is **PRD**.
- PRD status — resolved (reversed): a PRD has **no stored status**. Its board column is **derived at read time** from its Issues, and the board level collapses to backlog/in-progress/done. See [ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md). (Earlier drafts gave a PRD an authored 5-value `status` maintained on top of the issues — that is superseded.)
