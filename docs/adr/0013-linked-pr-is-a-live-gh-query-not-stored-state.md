# The Linked PR overlay is a live `gh` query, not stored state

## Status

accepted

## Context

A `done` PRD dead-ends: the review→merge flow lands all of a PRD's work on its **PRD feature branch** and explicitly leaves merging that branch to the repo's default branch out of scope (CONTEXT.md → Review outcome). So a `done` PRD is a feature branch sitting unmerged against `main`, with no PR. The **Open PR** action (CONTEXT.md) closes that gap — it pushes the feature branch and opens a GitHub PR from it — and the board then wants to *surface* that PR: a three-state card marker (no PR / open / merged) and a `go to PR` keybind. To render the marker and drive `go to PR`, the board needs to know, per `done` PRD, whether a PR exists and its state.

The question is **where that PR link lives.** Three shapes were on the table:

1. **A sidecar** keyed by PRD (`prd → pr-url`), written when Open PR runs, read at overlay time — mirroring the Liveness handle (ADR 0008) and the established overlay pattern.
2. **A `pr:` field in `prd.md`** — durable and portable, travels with the PRD.
3. **A live `gh` query** — query GitHub on each scan for the PRD's feature branch, store nothing.

The feature branch name is **purely derived** from the PRD directory (`featureBranchName(prdDir)`), so the identity a query needs is always available with no stored state. And the board already shells out to a subprocess on the scan path for an overlay — Liveness queries `claude agents --json` behind an injectable seam, bounded per scan — so a live external query is a proven pattern here, not a new risk class.

## Decision

The Linked PR overlay is a **live `gh` query**, storing nothing. On each scan, for each `done` PRD, the board queries `gh pr list --head <derived-feature-branch> --json state,url` (behind an injectable `PrSeam` mirroring the dispatch `GitSeam`, bounded per scan like Liveness) and joins the result onto the model at overlay time. The marker reads the returned `state` (`OPEN` → *PR open*, `MERGED` → *PR merged*, otherwise no marker); `go to PR` opens the returned `url`. Nothing is written to a sidecar or to `prd.md`.

We accept the hard dependency on `gh` + auth + network this implies, because the **Open PR** action already requires exactly that (it shells out to `git push` and `gh pr create`) — the dependency is paid the moment the feature exists at all, so the query adds no new requirement. A `gh` failure yields "no PR" (no marker), the same loud-but-harmless degradation Open PR surfaces.

## Consequences

- **The overlay is always truthful.** Because it reads GitHub live, the marker reflects reality even for a PR opened, merged, or closed *outside* Overseer, and it tracks an open PR transitioning to merged with no write. A stored URL (sidecar or `pr:` field) would go stale the instant the PR merged — the marker would still say "open" — so the only option that keeps the *merged* state honest is the live query. The end-of-lifecycle signal (the out-of-scope default-branch merge finally happened) is precisely the state a stored link cannot keep correct.
- **ADR 0003 is preserved.** A `pr:` field in `prd.md` would have made the board write a PRD field — the first ever — directly contradicting ADR 0003 (PRD status is derived, `prd.md` carries only `title` + body). The live query keeps `prd.md` field-free; the PR link is derived, exactly like PRD status.
- **The read-only viewer (ADR 0002) holds.** The query reads GitHub, never the watched root, and writes nothing. The board's outward *writes* are confined to the explicit, human-gated, confirmed Open PR action (`git push` + `gh pr create`); the overlay is pure read. So the new GitHub capability does not leak into the viewer's read-only contract — it mirrors how Liveness reads `claude agents` without writing.
- **`gh` joins `claude` and `git` on the scan path.** The board now shells out to a third external tool per scan. Bounded behind a `PrSeam` and gated to `done` PRDs only (the sole PRDs that can have a feature-branch PR), so the cost is proportional to finished work, not the whole board. Recorded here so a future reader does not "optimize" it into a cached sidecar without re-breaking the truthfulness above.
- **Open PR can refuse a duplicate for free.** Since the link is queried live rather than tracked, Open PR checks the same query before acting and refuses if a PR already exists (open or merged) — no double-PR, with no separate bookkeeping to keep in sync.
- **Rejected: sidecar / `prd.md` field.** Both would match the stored-overlay pattern and remove the per-scan subprocess, but both go stale on merge (breaking the merged state) and the field option also breaks ADR 0003. The live query's hot-path cost is the price of an overlay that cannot lie; given the `gh` dependency is already sunk by Open PR, that price is small.
