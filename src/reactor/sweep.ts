import { computeFrontier, type FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue, DispatchView } from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";
import { REVIEW_VERDICT_CLEAN } from "../model.js";
import { classifyReviewability } from "../review/eligibility.js";
import { classifyAuditability } from "../audit/eligibility.js";

/**
 * One PRD as the Reactor's sweep ingests it: where it lives (for deriving its
 * feature branch and dispatching it) and the {@link DispatchView} already read
 * from it. The Reactor reads each view from disk; the sweep itself stays pure.
 */
export interface PrdInput {
  /** The PRD directory, used by the orchestrator to derive its feature branch. */
  readonly prdDir: string;
  /** The PRD's dispatch view, read once by the orchestrator. */
  readonly view: DispatchView;
}

/**
 * One PRD after the sweep, carrying *all three* spawn edges' candidates so the
 * orchestrator drives them in a single pass:
 *
 * - {@link frontier} — every Issue's implementor classification; `runDispatch`
 *   takes only the `spawn`-classified entries, so the spawn-eligibility decision
 *   is the frontier's, computed here, not re-derived downstream.
 * - {@link auditors} — the auditable `ready-for-audit` Issues, the audit edge's
 *   frontier; `runAudit` acts on each.
 * - {@link reviewers} — the reviewable `ready-for-review` Issues, the reviewer
 *   edge's frontier; `runReview` acts on each. Eligibility is the *same*
 *   {@link classifyReviewability} the `r` keybind uses, so an Issue missing the
 *   repo, worktree, or branch the reviewer needs is excluded here rather than
 *   spawning a reviewer with nothing to check out, merge, or launch in.
 *
 * Its `view` is carried through so the orchestrator builds every edge's prompts
 * from the same read.
 */
export interface SweptPrd {
  readonly prdDir: string;
  readonly view: DispatchView;
  readonly frontier: readonly FrontierEntry[];
  /**
   * The auditable `ready-for-audit` Issues, the audit edge's frontier — the second
   * spawn edge (ADR 0026), sitting between the implementor frontier and the
   * reviewers. Eligibility is the shared {@link classifyAuditability} the `c`
   * keybind uses, so an Issue missing the repo or worktree the auditor needs is
   * excluded here rather than spawning an auditor with nothing to check out or run
   * in. No `blocked_by` re-check: blockers already gated the implementor, exactly
   * as the reviewer frontier does not re-check them.
   */
  readonly auditors: readonly DispatchIssue[];
  readonly reviewers: readonly DispatchIssue[];
  /**
   * The resolve-verdict candidates: `in-review` Issues carrying
   * `review_verdict: clean` (ADR 0019). The non-spawn fourth edge — the Reactor
   * runs the clean merge → `done` resolve on each, gated on the verdict (not on
   * liveness, so it is independent of the lingering-completed-row quirk). Unlike
   * {@link reviewers}, surfacing one does not spawn — "exactly three spawn edges"
   * holds. The merge handoff (repo/worktree/branch) is checked by the resolve
   * decision, not gated here: the sweep surfaces purely on the verdict.
   */
  readonly resolvers: readonly DispatchIssue[];
}

/**
 * The pure cross-PRD frontier sweep: for every PRD across the whole root,
 * compute all three spawn edges' candidates. These are the three — and only three
 * — spawn edges (CONTEXT.md → Status lifecycle; ADR 0026 added the audit edge);
 * the Reactor never spawns on an agent-owned transition or a human gate.
 *
 * **Implementor edge.** Reuses {@link computeFrontier} so the Reactor's notion of
 * "spawn an implementor now" is exactly the dispatcher's: an Issue is eligible
 * only when it is `ready-for-agent`, names a repo, and all its `blocked_by`
 * blockers are `done` (with `done` blockers cleared, cycles fail-safe to
 * `blocked`, and human/review statuses skipped).
 *
 * **Auditor edge.** Reuses {@link classifyAuditability} so the Reactor's notion of
 * "spawn an auditor now" is exactly the `c` keybind's: an Issue is an auditor
 * candidate only when it is `ready-for-audit` and carries the repo (the auditor's
 * launch target) and the worktree it checks out to compare against the plan. No
 * `blocked_by` re-check — blockers gated the implementor frontier, as the reviewer
 * edge does not re-check them.
 *
 * **Reviewer edge.** Reuses {@link classifyReviewability} so the Reactor's
 * notion of "spawn a reviewer now" is exactly the `r` keybind's: an Issue is a
 * reviewer candidate only when it is `ready-for-review` and carries the repo
 * (the reviewer's launch target), worktree, and branch the reviewer reads to
 * check out and merge. A normal implementor records all three in the same edit
 * that flips to `ready-for-review`, but a hand-set or half-written
 * `ready-for-review` Issue may be missing them — gating on the shared classifier
 * keeps the auto path from spawning a reviewer with nothing to check out, merge,
 * or launch in, instead of relying on the fields being present by construction.
 *
 * All edges are computed independently per PRD: `blocked_by` references resolve
 * only within the same PRD's view (a sibling filename), never across PRDs.
 *
 * Data-in/data-out, no I/O — the orchestrator does the reading and spawning.
 */
export function sweepFrontier(prds: readonly PrdInput[]): readonly SweptPrd[] {
  return prds.map(({ prdDir, view }) => ({
    prdDir,
    view,
    frontier: computeFrontier(view),
    auditors: view.issues.filter(isAuditCandidate),
    reviewers: view.issues.filter(isReviewerCandidate),
    resolvers: view.issues.filter(isResolveCandidate),
  }));
}

/**
 * Whether an Issue is an auditor-spawn candidate, via the shared
 * {@link classifyAuditability} the `c` keybind uses: `ready-for-audit` with a
 * recorded repo and worktree. Reusing it keeps the auto and manual audit edges
 * from drifting, so the Reactor never spawns an auditor the keybind would skip.
 */
function isAuditCandidate(issue: DispatchIssue): boolean {
  return classifyAuditability(issue).auditable;
}

/**
 * Whether an Issue is a reviewer-spawn candidate, via the shared
 * {@link classifyReviewability} the `r` keybind uses: `ready-for-review` with a
 * recorded repo, worktree, and branch. Reusing it — rather than re-deriving a
 * looser status+repo check — keeps the auto and manual reviewer edges from
 * drifting, so the Reactor never spawns a reviewer the keybind would have
 * skipped.
 */
function isReviewerCandidate(issue: DispatchIssue): boolean {
  return classifyReviewability(issue).reviewable;
}

/**
 * Whether an Issue is a resolve-verdict candidate (ADR 0019): `in-review` and
 * carrying `review_verdict: clean`. Gated on the verdict, **not** on liveness —
 * the verdict is what Overseer acts on, so a dead reviewer that nonetheless wrote
 * the verdict still resolves, and a live one that has not yet is left alone. The
 * merge handoff (repo/worktree/branch) is the resolve decision's concern, not a
 * sweep gate: the decision leaves an Issue missing them untouched.
 */
function isResolveCandidate(issue: DispatchIssue): boolean {
  return (
    issue.status === Status.IN_REVIEW &&
    issue.reviewVerdict === REVIEW_VERDICT_CLEAN
  );
}
