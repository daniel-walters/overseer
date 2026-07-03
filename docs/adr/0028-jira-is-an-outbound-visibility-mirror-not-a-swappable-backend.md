# JIRA is an outbound visibility mirror, not a swappable backend

## Status

accepted — but the **shape** (a PRD → Epic with child Tasks) is superseded by
[ADR 0032](./0032-jira-mirror-maps-a-prd-to-a-story-with-subtasks.md), which mirrors a PRD as
a **Story with native Sub-tasks**. The outbound-only, opt-in, log-only-failure decision below
stands unchanged.

## Context

The prompting question was "the backbone of the TUI is local markdown files — how would an adapter layer work where it could be e.g. JIRA or local markdown?" The obvious reading is a `Backend` port that the board reads from, with markdown and JIRA as peer implementations. That reading is a trap, because it assumes the markdown files are a *data source*. They are not — they play **three** roles at once:

1. **Source of work items** — what `scanBoard(root)` reads to build the board (a pure, synchronous `path → Board`).
2. **The agent coordination bus** — spawned `claude --bg` agents report progress *by editing frontmatter*: the implementor flips `in-progress → ready-for-audit` and records `worktree`/`branch`, the reviewer writes `review_verdict`. ADR 0002's read-only-viewer contract exists *because* the writers are external, uncoordinated processes and the file is the shared mutable substrate between them and Overseer.
3. **The change feed** — the watcher turns OS filesystem events into a debounced re-scan; "live-updating board" is literally "a file changed on disk."

Three shapes were weighed:

- **(A) Read-only projection** — an adapter feeds only role 1; a JIRA board is view-only (no dispatch, no agents). Markdown stays the only backend that supports the full pipeline.
- **(B) JIRA-as-sync-source** — JIRA is imported into the markdown tree; agents/dispatch/watcher are untouched because they still operate on files. The "adapter" is really a sync daemon.
- **(C) True backend port** — abstract read, write, *and* the coordination contract, so an agent finishing work calls `backend.setStatus(...)` instead of editing a file, and the watcher becomes `backend.subscribe(...)`. Markdown and JIRA are peers.

C is not an adapter; it is re-founding the app on a different substrate. Only role 1 is a data-source role JIRA can fill. Roles 2 and 3 are the load-bearing ones, and JIRA fills them badly: it has no inotify (role 3 degrades to polling), and using it as role 2 means either handing every spawned agent a JIRA write credential *or* stuffing Overseer's machine-state (`worktree`, `review_verdict`, …) into a human-readable ticket body — which corrupts the very artifact a human is meant to read, and lets any human editing that ticket clobber the bus. The property that makes JIRA valuable (humans read and write it) is exactly the property that makes it a terrible coordination bus, which must be machine-private. At least four ADRs (0002, 0003, 0006, 0008) encode "the file is the bus" as a *premise*.

The actual goal, once separated from the framing, is **stakeholder visibility**: people who live in JIRA want to *watch* agent progress. Nobody needs to *act* in JIRA. That is a one-directional, outbound concern.

## Decision

There is **no backend abstraction**. The markdown root remains the sole backbone and the sole coordination bus — read, write, watch, and agent hand-off all stay on the filesystem, unchanged. JIRA is added as an **outbound, opt-in, human-read-only mirror** of the board: Overseer *pushes* board state to JIRA and reads JIRA only to reconcile; JIRA never feeds back into the pipeline. Humans watch JIRA; they never drive work from it.

Architecturally the mirror is a **sibling of Open PR / Linked PR** (ADR 0013) — one of Overseer's few outward reaches to an external service, behind an injectable `JiraSeam` (mirroring the dispatch `GitSeam` and the Linked-PR `PrSeam`) — **not** a sibling of the scanner. It runs in-process on the existing scan loop (ADR 0005), diff-gated against an in-memory cache so scan frequency ≠ write frequency, and is opt-in per PRD (a `jira` block in `prd.md`), so PRDs across unrelated repos that need no JIRA visibility never touch it. The board is the sole source of truth; on any mismatch the board wins and the mirror self-heals (see CONTEXT.md → JIRA mirror).

## Consequences

- **The dispatch core is untouched.** No agent gains a JIRA write channel; no prompt is forked per backend; `writeStatus`, the flip-before-spawn idempotency lock, orphan reconciliation, and the sidecar overlays keep operating on files exactly as before. The mirror is additive and removable.
- **Visibility, not control.** JIRA cannot start, stop, or route work. This is the explicit no: a stakeholder dragging a JIRA card changes nothing in Overseer; the mirror will drive it back to match the board on the next reconcile. Bidirectional/collaborative use (two writers reconciling) is out of scope, deliberately, because it reintroduces exactly the shared-mutable-bus conflict this decision avoids.
- **JIRA is stale while the TUI is closed.** Being in-process (ADR 0005), the mirror only pushes while the board is open; work done overnight by background agents lands in JIRA on the next open. Accepted for a visibility mirror; a headless always-on sync daemon is a bigger, separate build.
- **Rejected (B) sync-source and (C) true backend.** B keeps markdown canonical but adds a bidirectional sync engine we don't need for pure visibility. C is recorded here so a future reader who re-encounters the original "adapter" framing does not build a `Backend` port and try to route agent coordination through JIRA — that path was weighed and rejected because the filesystem is the message bus between Overseer and its detached agents, not merely a data source.
