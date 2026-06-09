---
name: overseer-merge
description: Approve a human-review Overseer Issue — merge its recorded worktree branch into the PRD feature branch, set the Issue status to done, and clean up the worktree. Use when the user has finished resolving a human-review Issue and wants to merge and complete it. This is the human-invoked twin of the reviewer's automatic clean-AI merge.
---

# Overseer Merge

Approve a single Issue that is sitting in **`human-review`**: merge the work into its PRD feature branch, mark the Issue `done`, and clean up the worktree. This is the **single exit** from `human-review` and performs the *same* merge the clean-AI review path runs automatically — just human-invoked. This skill is self-contained; everything you need is below.

## The Overseer model (read this first)

An **Issue** is a markdown file (`NNN-slug.md`) inside a **PRD folder** — a directory containing a `prd.md` — under the **Overseer root**. The folder *is* the parent PRD; there is no parent reference. Overseer's TUI reads these files read-only and renders them as a live kanban board, so the moment you change an Issue's `status` the board reflects the move. Only agents and skills write Issue status; the viewer never does. You are an authorized writer here — respect the status transitions.

An Issue reaches `human-review` exactly three ways: a recorded **deviation** (the implementor strayed from the plan), an AI review that **couldn't converge**, or a **merge conflict** during the auto path. In every case a human resolves it *in place* — fixing by hand inside the worktree as needed — and then runs this skill to finish. There is no rework / bounce-back path: `human-review`'s only exit is `done`.

### Resolve the root and the Issue

Read the root from `~/.config/overseer/config.toml` (`root = "~/..."`; expand a leading `~`). Identify the target Issue from the argument or the conversation. If it's ambiguous, list the `human-review` Issues under the root and ask which one. The target Issue file **must** currently have `status: human-review` — if it doesn't, stop and tell the user (this skill is the single exit from `human-review` and operates on nothing else).

### Read the recorded handoff fields

From the Issue's frontmatter, read — **verbatim, never derived** (the implementor recorded them because `claude --bg` worktree/branch names are random, per ADR 0006):

- `worktree` — absolute path to the worktree the work was done in.
- `branch` — the branch to merge.
- `repo` — the target repo (its git toplevel path).

If `worktree` or `branch` is missing, stop and tell the user — there is nothing to locate or merge.

### Derive the PRD feature branch

The merge target is the **PRD feature branch** (never `main`). Overseer derives it deterministically from the **PRD directory's basename** (the folder the Issue lives in): lowercase it, replace every run of non-`[a-z0-9]` characters with a single `-`, and trim leading/trailing `-`. For example a PRD folder `Review Flow` → `review-flow`.

If that slug comes out **empty** — an all-punctuation or all-non-ASCII folder name, e.g. a CJK feature name — Overseer falls back to `prd-<hex>`, where `<hex>` is a short stable hash of the original name. You **must** apply the same fallback, or you'll target a different (empty/invalid) branch than the one the implementor's worktree was created from and the auto path merges into. Derive the name with this exact rule (it mirrors Overseer's `featureBranchName`):

```bash
node -e 'const n=process.argv[1]; const s=n.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); let h=0; for(const c of n) h=(h*31+c.codePointAt(0))>>>0; console.log(s||("prd-"+h.toString(16)))' "<PRD-folder-basename>"
```

Use exactly the name it prints — it is the same branch the implementor's worktree was created from and the same one the auto path merges into.

## Steps

1. **Verify the Issue is `human-review`.** Re-read the Issue frontmatter and confirm `status: human-review`. If not, stop.

2. **Verify a clean worktree.** Run `git -C <worktree> status --porcelain`. If there are uncommitted changes, tell the user and stop — don't commit for them. The human resolves in place, but the resolution must be committed before merging.

3. **Merge into the PRD feature branch** (in the target repo, not the worktree):
   ```bash
   git -C <repo> checkout <feature-branch>
   git -C <repo> merge --no-ff <branch>
   ```
   If the merge reports conflicts, **abort and stop**: run `git -C <repo> merge --abort` and tell the user there's a conflict to resolve. Never auto-resolve conflicts — they usually mean a sibling worktree moved the feature branch, and an agent must not resolve work it didn't reason about.

4. **Set the Issue status to `done`.** Edit the Issue file's frontmatter, changing `status: human-review` to `status: done`. This is the move the board reflects and what unblocks any sibling Issues that were `blocked_by` this one.

5. **Clean up the worktree:**
   ```bash
   git -C <repo> worktree remove <worktree>
   git -C <repo> branch -d <branch>
   ```
   If `worktree remove` refuses because the worktree is dirty or the branch won't delete, report it rather than forcing — the merge and `done` already stand.

6. **Report** — print: "Merged `<branch>` into `<feature-branch>`. Issue `<NNN-slug>` marked done. Worktree cleaned up." Mention any cleanup step that was skipped.
