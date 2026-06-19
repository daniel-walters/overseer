---
name: overseer-to-prd
description: Turn the current conversation context into a PRD and write it as a prd.md into the Overseer root. Use when the user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a **PRD** — a `prd.md` written into a new folder under the **Overseer root**. Do NOT interview the user — just synthesize what you already know (typically the output of a `/overseer-grill-with-docs` session). To interview first, run `/overseer-grill-with-docs`.

## The Overseer model (read this first)

A PRD is **a directory under the configured root containing a `prd.md` file**. Its Issues are sibling files inside that directory, created later by `/overseer-to-issues`. The root is **not a code repo** — it is the native home of PRD/Issue markdown, read live by the Overseer TUI. The code the PRD is about lives in separate repos (your session's working directories); only the PRD/Issue artifacts go to the root.

This skill is self-contained — everything you need is below.

### Resolve the root

Read the root from the Overseer config at `~/.config/overseer/config.toml`:

```toml
root = "~/work/prds"
```

Expand a leading `~` to the home directory. If the file is missing or has no `root`, tell the user to create it (`root = "~/your/prds"`) rather than guessing a location. Never assume the current working directory is the root — you are usually standing in a code repo, not the root.

## Process

1. Synthesize from the conversation and your codebase understanding. Use each code repo's domain glossary (`CONTEXT.md`) vocabulary throughout the PRD, and respect any ADRs in the areas you're touching.

2. Sketch the major modules you will need to build or modify. Actively look for opportunities to extract deep modules that can be tested in isolation. A deep module (vs. shallow) encapsulates a lot of functionality behind a simple, testable interface that rarely changes. Check with the user that these modules match their expectations, and which they want tests written for.

3. **Choose the PRD folder name.** A kebab-case slug derived from the feature (e.g. `auth-system`). This becomes the PRD's **identity** — it is the directory name and cannot easily change later. Propose it and confirm with the user before writing.

4. **Write the PRD file** to `<root>/<slug>/prd.md`.

   Frontmatter is **`title` only** — a human-readable display title. Write **no `status` field**: a PRD has no stored status. Overseer derives its board column at read time from its Issues — `done` only when there is ≥1 Issue and all are `done`; `in-progress` when any Issue is `in-progress` or later; otherwise `backlog`. So a PRD with no Issues yet reads as `backlog` automatically.

   ```markdown
   ---
   title: Auth System
   ---

   ## Problem Statement
   ...
   ```

   Put the PRD template below in the body, beneath the frontmatter.

   Write `prd.md` **first** — before any git work below. The Overseer root is not a
   git repo, so `prd.md` is committed nowhere; writing it first means a git failure in
   step 5 can never cost the PRD you just wrote.

5. **Commit the grill's docs onto the PRD feature branch.** The `/overseer-grill-with-docs`
   step that usually precedes this one writes domain-doc edits (`CONTEXT.md` /
   `CONTEXT-MAP.md` and `docs/adr/`) into each code repo's working tree but leaves them
   **uncommitted** — and on whatever branch was checked out during the grill, usually
   `main`. This is the step that lands them where they belong: on the PRD's feature
   branch, so the agents later dispatched off it inherit the glossary and ADRs that
   justify their work, instead of you cherry-picking stranded docs across branches by
   hand. The docs ride a feature branch (not a direct `main` commit) because Overseer is
   used by people whose flows cannot commit straight to `main` — the docs flow to `main`
   through the same per-repo review the code does.

   For **each of the session's working directories** — the launch directory plus any
   repo added with `/add-dir` — run the bundled script, resolving it relative to this
   skill's own directory:

   ```bash
   bash scripts/commit-docs.sh <repo> <branch-name>
   ```

   where `<branch-name>` is the **PRD slug** you chose in step 3 — the slug *is* the
   feature branch name (it is already kebab-case, so the branch name equals it). The
   script is self-guarding (a clean no-op in a repo with no pending doc edits, or one
   that is not a git repo) and idempotent (an existing feature branch is reused, never
   recreated), and it commits **only** the doc paths, leaving any unrelated work in the
   repo untouched.

   Do not modify the dispatch-time git setup — it remains the idempotent safety net and
   now usually finds the branch this step already created.

6. **Report each repo's outcome explicitly** — for every working dir, say whether the
   script **committed** (and onto which branch), found **nothing to commit**, or
   **failed** (with the reason it printed). A git failure must be loud here, not a silent
   stranding you discover at dispatch.

7. Tell the user the PRD was written and its path.

Do not create any Issue files here — that's `/overseer-to-issues`.

Next: `/overseer-to-issues` to decompose this PRD into Issues inside its folder.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions
- **Which code repo(s) the work happens in** — capture this, since `/overseer-to-issues` stamps each Issue with a `repo`. A feature may span several repos (the session's working directories).

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
