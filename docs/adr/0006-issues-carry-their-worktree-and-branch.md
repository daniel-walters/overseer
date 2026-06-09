# Issues carry their own worktree path and branch; review/merge read them, never derive

## Status

accepted

## Context

The review flow needs to locate an Issue's code: the reviewer must check out and review the implementor's worktree, and the merge must integrate its branch. The obvious approach is a deterministic branch name (e.g. `<feature-branch>-<issue-id>`) the reviewer reconstructs. But the `claude --bg` spike (`docs/SPIKE-FINDINGS.md`) found auto-isolated worktrees land on **random, uncontrollable** branch names (`worktree-<random-triple>`), and that merge tooling "must discover the branch via `git worktree list`, not assume a name." Discovery via `git worktree list` + the `claude agents --json` join key works but couples Overseer to `claude --bg`'s registry internals.

## Decision

The implementor records its **worktree path and branch** into the Issue's frontmatter in the same edit that flips the Issue to `ready-for-review`. The reviewer and the merge skill read these fields; they never derive or rediscover them. The markdown Issue stays the single source of truth, consistent with the rest of Overseer.

## Consequences

- The review PRD must extend the **implementor** side (its prompt and the Issue contract) to emit this handoff — review is not a purely additive downstream feature.
- Robust to the random-naming reality the spike documented, and decoupled from `claude --bg`'s agent registry.
- If an implementor fails to record the fields, its Issue cannot be reviewed or merged — the handoff is now a required part of "implementor done," not optional metadata.
