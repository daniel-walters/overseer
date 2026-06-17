# Delete-done-PRD is the board's first destructive write to the root — a keybind, not a skill

The board can delete a `done` PRD (its `prd.md`, all Issue files, and the directory) with a confirm-gated board-level keybind (`X`). This is a deliberate, recorded exception to [ADR 0002](./0002-agents-write-the-root-viewer-stays-readonly.md): until now the only writes to the watched root were status flips on Issue files (`writeStatus`) or agents writing their own files — never a *removal* of domain data. Delete is the board's first **destructive** root write, so a future reader hitting "the viewer never writes the root" needs to know why this one action does.

## Considered options

- **A bundled skill** (like `overseer-merge`), keeping the board a pure read-only viewer and letting the live re-scan reflect the folder vanishing. Rejected: the merge skill earns its existence because Claude does real judgment work there (resolve conflicts, merge a branch, decide the outcome). Deleting a directory has no judgment to delegate — it is `rm -rf` and nothing else — so a skill would be ceremony, not value, and would force a drop-out of the TUI for a trivial mechanical action that every other end-of-PRD action (`Open PR`, `go to PR`) performs in-board.
- **The chosen keybind**, behind a confirm preview, `done`-gated at board level beside `Open PR`. Accepted: it matches the in-board idiom of the other end-of-PRD actions and keeps the operation a single honest `rm -rf <prd-dir>`.

## Consequences

- The read-only-viewer invariant is now "the board never writes the root **except** this one explicit, human-only, `done`-gated, confirm-guarded destructive delete." The exception is narrow and recorded rather than a general loosening.
- The delete is **irreversible**: the root is not a git repo (no `git restore`, no reflog), and we deliberately chose a hard delete over an archive/trash. The confirm modal is the sole safety net — hence the shift-keyed `X` (the heavy-action family, never a bare key) and the `done`-only gate.
- The gate is `done`-**only**, not `done` + PR-merged: a `done` PRD whose feature branch was abandoned stays tidyable, and the human owns the "is this safe to lose?" call in the confirm rather than the board hard-blocking it. Deleting the *files* never touches the *work* (the code lives on the feature branch / [Linked PR](#)).
- Delete removes only the folder; the deleted Issues' liveness **sidecar** entries are left dangling-but-inert (the sidecar is read only as a join onto scanned Issues), the same way the suppressed failed-set tolerates stale entries. Reaping them is deferred housekeeping, not this keybind's job.
- The rendering side is free: the watcher's debounced re-scan rebuilds the board without the deleted folder, the same path that already tolerates a folder vanishing out-of-band.
