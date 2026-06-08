# `overseer init` silently overwrites bundled skills

## Status

accepted

## Context

Overseer ships a set of agent skills under `skills/` (e.g.
`overseer-grill-with-docs`, `overseer-to-prd`, `overseer-to-issues`). For these
to be usable, they have to be copied into the user's **global Claude skills
directory** (`$CLAUDE_CONFIG_DIR ?? ~/.claude` → `skills/`). The `overseer
init` subcommand performs that install as part of first-run onboarding.

Because the install target is the user's own filesystem, the installed copies
are **editable** — a user *can* open `~/.claude/skills/overseer-to-prd/SKILL.md`
and change it. Editing is discouraged (these are app-owned skills), but nothing
prevents it.

`init` is also explicitly designed to be **re-run** — both to pick up upstream
skill changes after an `overseer` upgrade and as a general "set me up" command.
So re-running `init` against an already-populated skills directory is the normal
case, not an edge case. That forces a decision: when an installed copy already
exists, what does `init` do with it?

The robust answer would track provenance: stamp each install with the package
version and a content hash, then on re-run distinguish "upstream changed" from
"user edited locally" and prompt before clobbering an edited copy. That requires
a manifest (or sidecar markers), version stamping, and per-skill hashing — real
machinery, with its own drift and correctness concerns.

The alternative is to treat the bundled skills as a **read-only source of
truth** the user is not meant to fork, and make `init` a plain mirror.

## Decision

**`overseer init` silently overwrites the bundled skills on every run.** There
is no manifest, no version stamp, no content hashing, and no per-skill
created/updated reporting.

For each subdirectory of the shipped `skills/` that contains a `SKILL.md`,
`init` performs a **per-skill remove-then-copy**: `rm -rf
<skills-root>/<skill>`, then a recursive copy of the shipped directory into its
place. The `rm -rf` is scoped strictly to each individual overseer skill
directory — never the skills root — so the user's unrelated skills are never
touched.

The consequence is deliberate and accepted: **if a user has locally edited an
installed copy of an overseer skill, that edit is destroyed on the next `init`
run, without warning, backup, or diff.** Editing the global copies is
discouraged precisely because they are app-managed and `init` reserves the right
to replace them.

## Consequences

- **The bundled skills are an exact mirror of what shipped.** Remove-then-copy
  (rather than an overlaying `fs.cp --force`) guarantees the installed copy is
  byte-identical to the source: a bundled resource that was renamed or deleted
  upstream does not linger as a stale orphan in the user's copy.
- **No provenance to maintain.** There is no on-disk record of "what version
  installed this." `init` does not need to read, parse, or reconcile any state
  before copying — it just mirrors. This removes an entire class of drift bugs
  (manifest out of sync with reality, hash of the wrong thing, version field
  polluting `SKILL.md` and confusing the parser).
- **Local edits are not a supported workflow.** A user who wants to customize an
  overseer skill should fork it under a *different* name (one without a
  `SKILL.md`-bearing twin in `skills/`), so `init` never targets it. Editing in
  place is fragile by design.
- **The skill set is self-describing.** `init` installs every `skills/`
  subdirectory containing a `SKILL.md` — the same "a directory with a marker
  file *is* the entity" rule Overseer uses for PRDs (a directory with `prd.md`
  *is* a PRD; see [CONTEXT.md](../../CONTEXT.md)). Adding a skill to the repo
  ships and installs it with no code change.
- **Reopening this is cheap on the install side, expensive on the trust side.**
  Adding hash/version tracking later is a backward-compatible enhancement to
  `init` (a fresh install just has no prior state to compare). But any user who
  has come to rely on editing global copies will have already lost edits — the
  discouragement has to be communicated up front, not retrofitted.
