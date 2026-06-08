import type { DispatchIssue, DispatchView } from "./reader.js";

/**
 * How the frontier classifies a single Issue for dispatch.
 *
 * - `spawn`   — eligible right now: spawn an implementor agent.
 * - `queued`  — eligible but waiting on a blocker that is not yet `done`.
 * - `blocked` — fail-safe: a dangling or cyclic dependency leaves it
 *               permanently blocked, reported, and never auto-dispatched.
 * - `skipped` — deliberately not dispatched (human-bound, not ready, or a
 *               missing/invalid repo), with a human-readable reason.
 */
export type Classification = "spawn" | "queued" | "blocked" | "skipped";

/** One Issue's place in the computed frontier. */
export interface FrontierEntry {
  readonly issue: DispatchIssue;
  readonly classification: Classification;
  /** Why this Issue is queued/blocked/skipped; absent for `spawn`. */
  readonly reason?: string;
}

const READY_FOR_AGENT = "ready-for-agent";
const DONE = "done";

/**
 * Classify every Issue in a PRD's dispatch view into spawn / queued / blocked /
 * skipped(+reason). Pure data-in/data-out — no I/O.
 */
export function computeFrontier(view: DispatchView): readonly FrontierEntry[] {
  const byId = new Map(view.issues.map((i) => [i.id, i]));
  const onCycle = findCyclicIssues(byId);
  return view.issues.map((issue) => classify(issue, byId, onCycle));
}

/**
 * The set of Issue ids that lie on a `blocked_by` cycle. Edges are only
 * followed through Issues that are present and not yet `done`: a `done` blocker
 * is already cleared, so a cycle routed through it can never actually stall the
 * frontier and is not reported. A missing blocker is handled separately (it
 * dangles, not cycles).
 */
function findCyclicIssues(
  byId: ReadonlyMap<string, DispatchIssue>,
): ReadonlySet<string> {
  const onCycle = new Set<string>();
  const VISITING = 1;
  const DONE_VISIT = 2;
  const state = new Map<string, number>();

  const visit = (id: string, stack: string[]): void => {
    state.set(id, VISITING);
    stack.push(id);

    for (const next of byId.get(id)?.blockedBy ?? []) {
      const blocker = byId.get(next);
      if (!blocker || blocker.status === DONE) continue; // dangling or cleared

      if (state.get(next) === VISITING) {
        // Found a back-edge: everything from `next` to the top of the stack
        // forms the cycle.
        const from = stack.indexOf(next);
        for (const member of stack.slice(from)) onCycle.add(member);
      } else if (state.get(next) !== DONE_VISIT) {
        visit(next, stack);
      }
    }

    stack.pop();
    state.set(id, DONE_VISIT);
  };

  for (const id of byId.keys()) {
    if (!state.has(id)) visit(id, []);
  }
  return onCycle;
}

function classify(
  issue: DispatchIssue,
  byId: ReadonlyMap<string, DispatchIssue>,
  onCycle: ReadonlySet<string>,
): FrontierEntry {
  if (issue.status !== READY_FOR_AGENT) {
    return {
      issue,
      classification: "skipped",
      reason: `status is "${issue.status ?? "(none)"}", not ${READY_FOR_AGENT}`,
    };
  }

  if (issue.repo === undefined || issue.repo.trim() === "") {
    return {
      issue,
      classification: "skipped",
      reason: "repo is missing or invalid",
    };
  }

  const missing = issue.blockedBy.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      issue,
      classification: "blocked",
      reason: `blocked_by references missing Issue(s): ${missing.join(", ")}`,
    };
  }

  if (onCycle.has(issue.id)) {
    return {
      issue,
      classification: "blocked",
      reason: "blocked_by forms a dependency cycle",
    };
  }

  const pending = issue.blockedBy.filter((id) => byId.get(id)?.status !== DONE);
  if (pending.length > 0) {
    return {
      issue,
      classification: "queued",
      reason: `waiting on blocker(s) not yet done: ${pending.join(", ")}`,
    };
  }

  return { issue, classification: "spawn" };
}
