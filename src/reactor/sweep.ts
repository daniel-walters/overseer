import { computeFrontier, type FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchView } from "../dispatch/reader.js";

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
 * One PRD after the sweep: its directory, its view (carried through so the
 * orchestrator builds prompts from the same read), and its computed frontier.
 * The orchestrator hands the frontier straight to `runDispatch`, which takes
 * only the `spawn`-classified entries — so the spawn-eligibility decision is the
 * frontier's, computed here, not re-derived downstream.
 */
export interface SweptPrd {
  readonly prdDir: string;
  readonly view: DispatchView;
  readonly frontier: readonly FrontierEntry[];
}

/**
 * The pure cross-PRD implementor sweep: classify every PRD's frontier across the
 * whole root, reusing {@link computeFrontier} so the Reactor's notion of "spawn
 * an implementor now" is exactly the dispatcher's. An Issue is implementor-spawn
 * eligible only when it is `ready-for-agent`, names a repo, and all its
 * `blocked_by` blockers are `done` — `computeFrontier` already encodes this as
 * the `spawn` classification (with `done` blockers cleared, cycles fail-safe to
 * `blocked`, and human/review statuses skipped).
 *
 * Eligibility is computed independently per PRD: `blocked_by` references resolve
 * only within the same PRD's view (a sibling filename), never across PRDs, so a
 * `001-foundation.md` in one PRD never satisfies another's blocker of the same
 * name.
 *
 * Data-in/data-out, no I/O — the orchestrator does the reading and dispatching;
 * this slice covers the implementor edge only (the reviewer-candidate sweep
 * builds on top in a later slice).
 */
export function sweepImplementorFrontier(
  prds: readonly PrdInput[],
): readonly SweptPrd[] {
  return prds.map(({ prdDir, view }) => ({
    prdDir,
    view,
    frontier: computeFrontier(view),
  }));
}
