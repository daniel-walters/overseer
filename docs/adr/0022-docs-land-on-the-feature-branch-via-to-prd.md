# Domain docs land on the PRD feature branch, committed by `to-prd`

## Status

accepted

## Context

The Overseer authoring pipeline is three skills in sequence:
`overseer-grill-with-docs` (interview the user and write `CONTEXT.md` glossary
terms + `docs/adr/` ADRs into the **code repos** the feature touches) →
`overseer-to-prd` (choose the PRD slug, write `prd.md` into the Overseer root) →
`overseer-to-issues` (decompose into Issue files). Only the PRD/Issue artifacts
live in the Overseer root; the **domain docs live with their code**, in each code
repo's working tree.

A PRD's per-repo **feature branch** is created **lazily, at dispatch time**:
`setUpRepos` (`src/dispatch/gitSetup.ts`) ensures `featureBranchName(prdDir)`
exists — creating it from the repo's resolved default base
(`origin/HEAD` → `origin/main`) if absent — and checks it out the moment you
press `d`, so each agent's worktree branches from it.

That lazy creation is the root of a **doc-stranding bug** that bit real dogfood
runs. The grill writes the glossary/ADR edits *before any branch exists* — so they
land on whatever branch happened to be checked out during the interview (often
`main`, or a stray branch). The agents later dispatch off a *separate* feature
branch that **does not contain the docs that justify their work**. In one run the
docs had to be cherry-picked across branches afterward to reunite them.

Two further constraints shaped the fix:

- **Overseer is used by people who cannot commit to `main`.** "Just commit the docs
  to `main`" — the tempting one-line fix — is not open to every user's flow (branch
  protection, review gates). The docs must ride a **feature branch** that becomes a
  PR, exactly like the code, so they flow through the same review the
  [Open PR](../../CONTEXT.md#open-pr) flow already pushes.
- **The branch name isn't knowable until the slug is chosen.**
  `featureBranchName(prdDir)` derives from the PRD directory slug, and that slug is
  chosen and confirmed with the user in `to-prd` — *after* the grill. You cannot
  commit to a branch you cannot yet name.

That second constraint is the knot. It forces the question of *which skill* owns
branch creation, given the grill writes the docs but `to-prd` names the branch.

## Decision

**`overseer-to-prd` creates the feature branch and commits the docs onto it.** The
grill stays a pure interview-and-write-files skill — it writes the doc edits into
each repo's working tree and leaves them **uncommitted**. When `to-prd` chooses and
confirms the slug (the first moment the branch name genuinely exists), it does the
git work, via a deterministic bundled script.

- **Deferred-commit, not branch-during-grill.** The rejected alternative was to make
  the *grill* create the branch — which forces the grill to name the PRD, splitting
  PRD-identity across two skills. Deferring the git work by one pipeline step costs
  nothing in stranding (dispatch is still downstream of both), and keeps the slug
  decision wholly in `to-prd`. `git checkout` carries the uncommitted doc edits onto
  the newly-created branch, so nothing is copied by hand.

- **A bundled `bash` script, not LLM-run git prose.**
  `skills/overseer-to-prd/scripts/commit-docs.sh <repo-path> <branch-name>`, invoked
  by the skill once per session working dir and **self-guarding** so it is a no-op
  where there is nothing to do:
  1. exit 0 if `<repo-path>` is not a git repo;
  2. exit 0 (no-op) if there are no pending changes under the doc paths
     (`CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, and the per-context nested variants
     where a `CONTEXT-MAP.md` exists) — this repo had no doc edits;
  3. resolve the base (`origin/HEAD` → `origin/main` fallback) — identical to
     `gitSetup.defaultBase`;
  4. create `<branch-name>` from base if absent, then checkout (idempotent: an
     existing branch is reused, never recreated);
  5. `git add` **only the doc paths** — unrelated dirty work the user has staged or
     modified stays untouched;
  6. commit with a **dynamic message** reflecting what was actually staged:
     `docs: CONTEXT + ADRs for <branch>` / `docs: CONTEXT for <branch>` /
     `docs: ADRs for <branch>`.

- **`prd.md` is written first, then the script runs per repo.** The PRD is a plain
  file write into the **non-git** Overseer root (it is committed *nowhere*); the doc
  commits are independent writes into code repos. Writing the PRD first means a git
  failure in any repo never costs the already-written PRD, and the uncommitted docs
  remain recoverable in the working tree. Each repo's outcome — committed / no-op /
  failed-with-reason — is reported explicitly, so a failure is loud, not silent.

- **`gitSetup` is unchanged.** It is *already* idempotent (its `branchExists` guard).
  After this change it simply usually finds the branch already present (created by
  `to-prd`) and checks it out; for a repo touched only by an Issue's *code* and never
  by a doc edit, it still creates the branch lazily at dispatch. Its expectation flips
  from "usually creates" to "usually finds, occasionally creates" — no code change.

## Consequences

- **The feature branch is the single home of a feature's docs *and* its code from
  before dispatch.** Every agent dispatched off `featureBranchName(prdDir)` inherits
  the canonical glossary and ADRs as its base — the docs that justify its work — and
  they flow to `main` through the same PR the code does ([Open PR](../../CONTEXT.md#open-pr)).
  No post-hoc cherry-pick.

- **`to-prd` gains a git responsibility it never had** — an authoring skill now
  creates branches and commits. This is the surprising part a future reader is warned
  about here. It is a deliberate, narrow write (scoped to doc paths, idempotent,
  self-guarding), consistent with [ADR 0002](./0002-agents-write-the-root-viewer-stays-readonly.md)'s
  principle that the *board* stays read-only — this is a skill in the authoring
  pipeline, not the TUI.

- **The base-resolution logic is implemented twice** — in the bundled `bash` script
  and in `gitSetup.ts` — because the script (a skill helper under `~/.claude/skills/`)
  and the in-process TS seam cannot share code. This is an accepted, conscious
  duplication: the script eliminates the *execution* fragility (no more git prose the
  model re-improvises each run) without unifying the *logic*. The two must stay
  behaviorally identical on base resolution and `featureBranchName` derivation — the
  same standing coupling [ADR 0021](./0021-approve-keybind-shares-the-reactors-merge-seam.md)
  notes between the `overseer-merge` skill and the TS merge seam.

- **The script ships for free via `init`.** `installSkills`
  ([ADR 0004](./0004-init-silently-overwrites-bundled-skills.md)) does a recursive
  `cpSync` of each skill directory, so `scripts/commit-docs.sh` rides along with no
  init code change. It is invoked as `bash scripts/commit-docs.sh …` rather than by
  the executable bit, so the copy's file mode is irrelevant.

- **The grill→to-prd window holds uncommitted docs.** Between the two skills the doc
  edits sit uncommitted in each repo's working tree. This is accepted: the pipeline is
  tight and uncommitted changes are branch-agnostic, so they follow the user onto the
  feature branch when `to-prd` checks it out. A user who abandons the pipeline after
  the grill simply has uncommitted doc edits — recoverable, never lost.
