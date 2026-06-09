import { computeFrontier, type FrontierEntry } from "../dispatch/frontier.js";
import {
  hasValue,
  type DispatchIssue,
  type DispatchView,
} from "../dispatch/reader.js";
import { Status } from "../dispatch/status.js";

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
 * One PRD after the sweep, carrying *both* spawn edges' candidates so the
 * orchestrator drives them in a single pass:
 *
 * - {@link frontier} — every Issue's implementor classification; `runDispatch`
 *   takes only the `spawn`-classified entries, so the spawn-eligibility decision
 *   is the frontier's, computed here, not re-derived downstream.
 * - {@link reviewers} — the `ready-for-review` Issues with a recorded repo, the
 *   reviewer edge's frontier; `runReview` acts on each. Missing-repo Issues are
 *   excluded here (the reviewer has nothing to launch in), mirroring how the
 *   implementor frontier excludes a missing repo.
 *
 * Its `view` is carried through so the orchestrator builds both edges' prompts
 * from the same read.
 */
export interface SweptPrd {
  readonly prdDir: string;
  readonly view: DispatchView;
  readonly frontier: readonly FrontierEntry[];
  readonly reviewers: readonly DispatchIssue[];
}

/**
 * The pure cross-PRD frontier sweep: for every PRD across the whole root,
 * compute both spawn edges' candidates. These are the two — and only two —
 * spawn edges (CONTEXT.md → Status lifecycle); the Reactor never spawns on an
 * agent-owned transition or a human gate.
 *
 * **Implementor edge.** Reuses {@link computeFrontier} so the Reactor's notion of
 * "spawn an implementor now" is exactly the dispatcher's: an Issue is eligible
 * only when it is `ready-for-agent`, names a repo, and all its `blocked_by`
 * blockers are `done` (with `done` blockers cleared, cycles fail-safe to
 * `blocked`, and human/review statuses skipped).
 *
 * **Reviewer edge.** An Issue is a reviewer candidate when it is
 * `ready-for-review` and names a repo (the reviewer's launch target). A blank
 * repo counts as missing and is excluded. The other handoff fields (worktree,
 * branch) are the reviewer's concern, not the sweep's: the implementor records
 * them in the same edit that flips to `ready-for-review`, so a `ready-for-review`
 * Issue carries them by construction — and `runReview` is total if one is
 * absent. The sweep gates on the same "recorded repo" rule the implementor
 * frontier does, no more.
 *
 * Both edges are computed independently per PRD: `blocked_by` references resolve
 * only within the same PRD's view (a sibling filename), never across PRDs.
 *
 * Data-in/data-out, no I/O — the orchestrator does the reading and spawning.
 */
export function sweepFrontier(prds: readonly PrdInput[]): readonly SweptPrd[] {
  return prds.map(({ prdDir, view }) => ({
    prdDir,
    view,
    frontier: computeFrontier(view),
    reviewers: view.issues.filter(isReviewerCandidate),
  }));
}

/**
 * Whether an Issue is a reviewer-spawn candidate: `ready-for-review` with a
 * recorded (non-blank) repo. The repo gate keeps a reviewer that could only fail
 * to launch off the frontier — the reviewer-edge counterpart to the implementor
 * frontier excluding a missing repo.
 */
function isReviewerCandidate(issue: DispatchIssue): boolean {
  return issue.status === Status.READY_FOR_REVIEW && hasValue(issue.repo);
}
