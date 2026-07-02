---
name: overseer-grill-prep
description: Survey a project and interview the user divergently to surface a slate of rough candidate PRD shapes, written to the Overseer root as a staging doc. The breadth-first head of the authoring pipeline — run it before /overseer-grill-with-docs when you have a goal but don't yet know what PRDs it should break into. Use when the user wants to explore what features a project needs, or mentions "what PRDs", "shape the work", or "grill prep".
---

# Grill Prep

Surface a **slate of candidate PRD shapes** from a fuzzy project goal, and write it to the Overseer root as a staging doc the user later grills one entry at a time.

This is the **breadth-first head** of the authoring pipeline. `/overseer-grill-with-docs` assumes you already have *one* design to stress-test; this step runs *before* it, when you have a goal but don't yet know what features (PRDs) it should break into.

```
grill-prep        →   grill-with-docs   →   to-prd   →   to-issues
(project →            (converge on ONE      (write the   (slice into
 candidate PRDs)       candidate)            PRD)         Issues)
```

## The two laws of this skill

**Diverge, don't converge.** Grill *narrows* — it resolves every branch of one design. This skill does the opposite: it *opens up* the space and resists premature narrowing. Surface candidates, split and merge them, sequence them — but do **not** resolve their internal design branches. That is grill's job, downstream, one candidate at a time.

**Stay pure.** Write exactly one artifact: the slate (below). Do **not** write `CONTEXT.md`/`CONTEXT-MAP.md` or ADRs (nothing is resolved yet — that's grill's job), and do **not** write any `prd.md` (that's `to-prd`'s job). Read docs and code freely for context; write only the slate.

## The Overseer model (read this first)

A PRD is a directory under the configured root containing a `prd.md`. The slate is **not** a PRD — it is a staging doc that lists *candidate* PRDs before any of them exists. It lives in a reserved `_slate/` folder under the root. Because the Overseer board treats a directory as a PRD **only if it contains `prd.md`** (and skips plain files), a `_slate/` folder holding `.md` files is invisible to the board — the slate never renders as a card. This skill is self-contained — everything you need is below.

### Resolve the root

Read the root from `~/.config/overseer/config.toml`:

```toml
root = "~/work/prds"
```

Expand a leading `~` to the home directory. If the file is missing or has no `root`, tell the user to create it (`root = "~/your/prds"`) rather than guessing. Never assume the current working directory is the root — you are usually standing in a code repo, not the root.

### Multi-root awareness

Your session typically spans several code repos — the launch directory plus any added with `/add-dir` — because the work spans them. During the survey, read each repo's `CONTEXT.md`/`CONTEXT-MAP.md` and `docs/adr/` for vocabulary and prior decisions, and note **which repo(s)** each candidate touches. The slate records candidate repos so the eventual Issues can be stamped (`/overseer-to-issues` needs a `repo` per Issue).

## Process

1. **Provocation.** Have the user state the goal/direction in their own words. One or two sentences is enough to start — you'll sharpen it. If they've already described it in the conversation, reflect it back as the provocation and confirm.

2. **Survey to seed.** Explore the relevant code repos, the existing PRDs at the root (the sibling directories of `_slate/`, so you don't propose what already exists), and each repo's domain docs. From what already exists, infer an **initial** slate of candidate feature-shapes. Lean on the code: a half-built capability, a TODO-dense module, or a glossary term with no feature behind it are all candidate seeds.

3. **Interview to expand.** Ask divergent, breadth-opening questions — "what *else* must this do?", "who else touches this?", "what breaks if we ship only that?" — one at a time, waiting for each answer. Cluster the answers into candidates; split a candidate that's really two features, merge two that are really one, and surface dependencies/sequencing between them. Each candidate is a feature a user would value independently — **not** a vertical work-slice (that granularity is for `/overseer-to-issues`, one level down).

4. **Write the slate** to `<root>/_slate/<initiative-slug>.md`, using the template below. `<initiative-slug>` is a kebab-case slug for the whole project/goal; confirm it with the user. If the file already exists (a prior session on the same initiative), merge into it rather than clobbering — add new candidates, update existing ones, never silently drop one.

5. **Report and hand off.** Tell the user the slate's path and list the candidate slugs. Then point onward (see "When you're done").

## The slate file

Each candidate's `###` heading **is the future PRD folder slug** — kebab-case, reused verbatim by `/overseer-to-prd` when that candidate is promoted — so name it as the PRD's permanent identity, not a throwaway label.

```markdown
---
title: <Initiative name>
---

## Goal

The provocation, sharpened — what the whole project is for, from the user's perspective.

## Current state

2-4 lines from the survey: what already exists, what's half-built, where the gaps are.

## Candidates

### auth-system
> status: candidate
**Problem:** What's missing, from the user's perspective (1-2 lines).
**Rough scope:** in: the core of it / out: what this candidate deliberately excludes.
**Repos:** api, web
**Unknowns:** The open questions a grill session should drill first — this is the agenda you hand to grill.
**Depends on:** billing-export   <!-- optional; omit if independent -->

### billing-export
> status: candidate
**Problem:** …
**Rough scope:** in: … / out: …
**Repos:** api
**Unknowns:** …
```

- **`### <slug>`** — the future PRD folder name. Kebab-case, permanent identity.
- **`> status:`** — `candidate` at birth; flips to `promoted` once a candidate has been grilled and turned into a real PRD. Promotion is **manual** — leave the status for the human to flip; do not couple it into `to-prd`. It's just a living-doc marker so the user can see what's left.
- **`Unknowns`** — the deliberate hand-off to grill. Put the sharpest open questions here; grill starts from them.
- **`Depends on`** — sequencing between candidates only. Omit when independent.

## When you're done

Breadth work has no fixed end — stop when the candidate set feels like it covers the goal and each candidate is sharp enough to grill. List the candidates and point onward:

Next: `/overseer-grill-with-docs`. Name a candidate to grill it directly (e.g. `auth-system`), or invoke it with no area and it will list the slate's candidates for you to pick — so you never have to open the file by hand. Grill drills the chosen candidate's Problem + Unknowns into a settled design, then `/overseer-to-prd` writes the real PRD.
