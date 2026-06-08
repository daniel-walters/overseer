---
name: overseer-to-issues
description: Break a PRD into independently-grabbable Issue files written into the PRD's folder under the Overseer root, using tracer-bullet vertical slices. Triage is folded in — each Issue is born routed (ready-for-agent / ready-for-human). Use when the user wants to convert a PRD or plan into Issues.
---

# To Issues

Break a plan into independently-grabbable **Issues** using vertical slices (tracer bullets), and write them as files into the PRD's folder under the **Overseer root**.

## The Overseer model (read this first)

An **Issue** is a markdown file inside a PRD directory. It belongs to that PRD by virtue of where it lives — there is no "parent" reference, the folder *is* the parent. Issues are read by the Overseer TUI as kanban cards, and by Overseer's dispatcher to spawn implementor agents — so the frontmatter contract below must be emitted exactly. (If you are working in the Overseer source repo itself, its `CONTEXT.md` and `docs/adr/` hold the full domain model; otherwise this skill is self-contained.)

### Resolve the root and the PRD folder

Read the root from `~/.config/overseer/config.toml` (`root = "~/..."`, expand a leading `~`). The Issues go into a **PRD folder** under that root — a directory containing a `prd.md`. Identify the target PRD (from the argument, the conversation, or by asking). Never assume the cwd is the root; you are usually standing in a code repo.

### File contract — match it exactly

The dispatcher parses these fields; emit them verbatim or work won't dispatch.

**Filename:** `NNN-slug.md` (e.g. `001-auth.md`, `002-password-reset.md`).
- `NNN` is a zero-padded 3-digit sort key. **Scan the PRD folder for existing `NNN-*.md`, take the numeric max (0 if none), and assign `max+1, max+2, …` across the batch.** Never reuse or backfill gaps — only ever append above the current max. Order is incidental/positional, not priority.
- `slug` is kebab-case from the Issue title.

**Frontmatter:**

```yaml
---
title: Password reset flow
status: ready-for-agent        # ready-for-agent (AFK) | ready-for-human (HITL)
repo: /Users/you/code/app      # local toplevel path of the code repo this work happens in
blocked_by:                    # list of sibling Issue filenames; omit if none
  - 001-auth.md
---
```

- **`status`** — folded-in triage (see below). AFK slice → `ready-for-agent`; HITL slice → `ready-for-human`. There is no `backlog`/`needs-triage` limbo; an Issue is born routed.
- **`repo`** — the **local absolute toplevel path** of the code repo where this Issue's work happens (`git rev-parse --show-toplevel`). Required for AFK Issues — the dispatcher *skips* an Issue with a missing/invalid `repo`. See "Sourcing `repo`" below.
- **`blocked_by`** — a YAML list of **full sibling filenames** (`001-auth.md`), `NNN-` prefix included. The dispatcher reads this verbatim to gate dispatch. Omit the field entirely when there are no blockers. Blocking lives here in frontmatter, **not** in the body.

**Body:** `## What to build` + `## Acceptance criteria` (template below). No "Parent" section — the folder is the parent.

## Process

### 1. Gather context

Work from whatever is in the conversation (typically a `/overseer-grill-with-docs` + `/overseer-to-prd` session). If the user passes a PRD reference (folder name or path), read its `prd.md`.

### 2. Explore the codebase (optional)

If you haven't already, explore the relevant code repo(s) to ground the slices. Use each repo's domain glossary (`CONTEXT.md`) for titles and descriptions, and respect ADRs in the areas you touch.

### 3. Draft vertical slices

Break the plan into **tracer bullet** Issues. Each is a thin vertical slice cutting through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices are **AFK** or **HITL**. HITL slices require human interaction (an architectural decision, a design review); AFK slices can be implemented and merged without it. Prefer AFK where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice show:

- **Title**
- **Routing**: AFK (`ready-for-agent`) / HITL (`ready-for-human`)
- **Repo**: which code repo the work happens in
- **Blocked by**: which other slices (by their planned filename) must complete first
- **User stories covered** (if the source has them)

Ask:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the AFK/HITL routings correct? (this is the triage decision — it sets each Issue's `status`)
- Is each slice's `repo` correct?

Iterate until the user approves.

### Sourcing `repo` (triage detail)

A feature may span several code repos — typically the session's working directories (the dir you launched in plus any `/add-dir`'d). A good `/overseer-grill-with-docs` + `/overseer-to-prd` session will have established which repo each slice targets; read that from context. For each candidate repo, the `repo` value is its `git rev-parse --show-toplevel`. When only one repo is in play, stamp them all the same. When a slice's repo is genuinely ambiguous, ask.

### 5. Write the Issue files

Write each approved slice to `<root>/<prd>/NNN-slug.md` using the contract above. Process slices in dependency order (blockers first) so you know each blocker's final filename before writing the Issues that reference it in `blocked_by`.

<issue-template>
## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
</issue-template>

Do NOT modify the `prd.md`. A PRD has no stored status — its board column is derived from these Issues automatically.
