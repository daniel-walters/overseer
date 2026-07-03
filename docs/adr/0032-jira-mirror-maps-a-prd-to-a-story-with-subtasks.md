# JIRA mirror maps a PRD to a Story with Sub-tasks, not an Epic with children

## Status

accepted

## Context

The JIRA mirror ([ADR 0028](./0028-jira-is-an-outbound-visibility-mirror-not-a-swappable-backend.md))
originally mirrored a PRD as a JIRA **Epic** and each [Issue](../../CONTEXT.md) as a
standard **Task** parented to that epic via the native `parent` field
([ADR 0029](./0029-mirror-identity-lives-in-frontmatter-backrefs.md) recorded the
identity backrefs `jira_epic`/`jira_key`). That shape has a cost the stakeholder-visibility
goal actually cares about: an epic **fans out N separate board cards** (the epic lives in
the epic panel; each child is its own backlog card), so a PRD reads on the board as a
scatter of tickets rather than one legible unit.

Two things converged to force a rethink, both surfaced live while dogfooding the mirror on
the `refresh-agent-output` PRD:

1. **Shape preference.** The desired reading is *one feature card with its work items
   nested inside it* — the JIRA hierarchy level *below* an epic: a standard issue carrying
   **native Sub-tasks**. Sub-tasks don't get their own backlog cards; they show under their
   parent, which is exactly the "one card, subtasks within" mental model.
2. **A targeting bug that made the whole thing fail silently.** `resolveProject` shelled out
   to `board list-projects` and took **`list-projects[0]`**, the first-listed project — even
   though ADR 0028 and CONTEXT.md both already specified the project is *"derived from the
   board's location."* Board 681 (the ESD "Survey Design" board) is a **multi-project filter
   board** that lists `CABB` (a bug project with no `Epic` issue type) *before* `ESD`. So the
   mirror tried to create the epic in `CABB`, which rejected the `Epic` type, and — because a
   failed push is a logged no-op ([ADR 0028](./0028-jira-is-an-outbound-visibility-mirror-not-a-swappable-backend.md))
   — nothing surfaced on the board. The epic-in-`CABB` failure was the symptom; the code
   diverging from the documented "location" intent was the cause.

JIRA's hierarchy is strict — `Epic (L1) → Story/Task (L0) → Sub-task (L−1)` — and the target
project (ESD) offers `Epic`, `Story`, `Task`, `Sub-task`, `Bug`. A "feature card" is a
standard-level issue; **Story** was chosen over Task because a PRD is a user-facing capability
described in user-story language (Story reads as "a feature," Task as "a chore"). Board
placement is emergent: board 681's filter is project-scoped, so an issue created *in ESD*
appears on the Survey Design backlog automatically (verified — the dogfood items showed on the
board), and a Sub-task follows its parent Story's backlog/sprint by JIRA's own rules.

## Decision

Mirror a PRD as a JIRA **Story** (the *feature card*) and each Issue as a native **Sub-task**
under it (`--type Sub-task --parent <story>`), superseding ADR 0028's Epic-with-child-Tasks
shape. The whole PRD reads as one board card with its work items nested inside.

- **Status mapping is unchanged** in substance, retargeted onto the new types: the Story's
  status tracks the PRD's derived lane (*To Do* / *In Progress* / *Done*); each Sub-task's
  status carries the same four-bucket Issue coarsening as before.
- **Identity backref renamed** `jira_epic → jira_story` on `prd.md` (the child `jira_key` is
  type-neutral and unchanged) — the field now names a Story, so the old name would be a lie.
  Safe because no live mirrored PRD survives the change (the one dogfood epic is being deleted
  by hand); pre-existing epics are **left as-is, not migrated** — the mirror only reshapes
  PRDs it has not yet linked.
- **Project resolution corrected to match the long-documented "location" intent**: a
  single-project board resolves to its one project; a multi-project filter board resolves to
  the project named by the board's *location*, cross-referenced against the board's project
  list for a validated key (never blindly `list-projects[0]`); an explicit `project` override
  wins when set and is the required fallback when the home project can't be resolved. This is a
  bugfix (code → documented spec), recorded here only because it shared the incident.
- **Silent-failure behavior is deliberately left unchanged**: every mirror failure, create or
  update, stays a logged no-op in `mirror.log` (ADR 0028's low-noise stance). A board marker
  for create failures was weighed and declined — the targeting fix removes the failure that
  actually bit, and the log is accepted as the channel.

## Consequences

- **Sprint placement stays deferred but gets simpler.** acli still exposes no "add existing
  work item to a sprint" op, so `target: sprint` continues to degrade to backlog until a
  REST-token seam. But under the new shape only the **Story** is ever placed and its Sub-tasks
  follow it, so placement becomes one decision per PRD rather than N per Issue — the acli
  dead-end shrinks rather than moving.
- **ADR 0028's shape section is superseded here** (a pointer is added there), and **ADR 0029's
  `jira_epic` field is renamed `jira_story`** (pointer added there too). The rest of both ADRs
  — the outbound-only mirror, the backref-over-sidecar identity, the diff-gated reconcile —
  stand unchanged.
- A future reader who finds the mirror creating `Story`/`Sub-task` and wonders why 0028 says
  "Epic" is answered here: the epic fanned out N cards; the feature-card-with-subtasks shape
  reads as one unit, which is what a visibility mirror is for.
