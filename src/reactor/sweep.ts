import { computeFrontier, type FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue, DispatchView } from "../dispatch/reader.js";
import { classifyReviewability } from "../review/eligibility.js";

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
 * - {@link reviewers} — the reviewable `ready-for-review` Issues, the reviewer
 *   edge's frontier; `runReview` acts on each. Eligibility is the *same*
 *   {@link classifyReviewability} the `r` keybind uses, so an Issue missing the
 *   repo, worktree, or branch the reviewer needs is excluded here rather than
 *   spawning a reviewer with nothing to check out, merge, or launch in.
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
