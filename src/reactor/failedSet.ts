import type { SpawnEdgeKind } from "../dispatch/failureLog.js";

/**
 * A session-scoped record of `(issueId, edge)` spawns that failed to launch, so
 * the level-triggered Reactor stops re-picking-up a rolled-back Issue on the
 * next reconcile and retrying its failed spawn forever (PRD: spawn-failure
 * suppression).
 *
 * The key is *per edge*: a failed implementor spawn suppresses only the
 * implementor edge for that Issue, never the reviewer edge for the same Issue
 * (and vice versa), so one failing edge can't mask a legitimate later spawn on
 * the other. The Reactor subtracts this set from each swept frontier and records
 * into it on a spawn failure.
 */
export interface FailedSet {
  /** Mark `(issueId, edge)` as a failed spawn for the rest of this session. */
  record(issueId: string, edge: SpawnEdgeKind): void;
  /** Whether `(issueId, edge)` has been recorded as a failed spawn. */
  has(issueId: string, edge: SpawnEdgeKind): boolean;
}

/**
 * Build a fresh {@link FailedSet}. It is constructed per `createReactor`
 * instance, so it is session-scoped: re-opening the board makes a new set and
 * retries every previously-failed spawn. Spawn failures are transient (a bad
 * binary, a git hiccup), so reopen is the natural — and bounded — retry gesture:
 * a permanent failure re-attempts at most once per session, logged each time.
 */
export function createFailedSet(): FailedSet {
  // One flat string set keyed by `issueId\tedge`; the tab can't appear in an
  // Issue filename, so the two halves of the key never collide.
  const failed = new Set<string>();
  const key = (issueId: string, edge: SpawnEdgeKind): string =>
    `${issueId}\t${edge}`;

  return {
    record(issueId, edge) {
      failed.add(key(issueId, edge));
    },
    has(issueId, edge) {
      return failed.has(key(issueId, edge));
    },
  };
}
