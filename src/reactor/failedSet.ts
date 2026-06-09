import type { SpawnEdgeKind } from "../dispatch/failureLog.js";

/**
 * A session-scoped record of `(issueKey, edge)` spawns that failed to launch, so
 * the level-triggered Reactor stops re-picking-up a rolled-back Issue on the
 * next reconcile and retrying its failed spawn forever (PRD: spawn-failure
 * suppression).
 *
 * The `issueKey` is opaque to the set — the Reactor uses each Issue's full path
 * (`prdDir/filename`), not its bare filename, since it sweeps across every PRD
 * and filenames are only unique within a PRD. Keeping the key opaque here lets
 * the caller own that decision.
 *
 * The key is also *per edge*: a failed implementor spawn suppresses only the
 * implementor edge for that Issue, never the reviewer edge for the same Issue
 * (and vice versa), so one failing edge can't mask a legitimate later spawn on
 * the other. The Reactor subtracts this set from each swept frontier and records
 * into it on a spawn failure.
 */
export interface FailedSet {
  /** Mark `(issueKey, edge)` as a failed spawn for the rest of this session. */
  record(issueKey: string, edge: SpawnEdgeKind): void;
  /** Whether `(issueKey, edge)` has been recorded as a failed spawn. */
  has(issueKey: string, edge: SpawnEdgeKind): boolean;
}

/**
 * Build a fresh {@link FailedSet}. It is constructed per `createReactor`
 * instance, so it is session-scoped: re-opening the board makes a new set and
 * retries every previously-failed spawn. Spawn failures are transient (a bad
 * binary, a git hiccup), so reopen is the natural — and bounded — retry gesture:
 * a permanent failure re-attempts at most once per session, logged each time.
 */
export function createFailedSet(): FailedSet {
  // One flat string set keyed by `issueKey\tedge`; the tab can't appear in a
  // file path, so the two halves of the key never collide.
  const failed = new Set<string>();
  const key = (issueKey: string, edge: SpawnEdgeKind): string =>
    `${issueKey}\t${edge}`;

  return {
    record(issueKey, edge) {
      failed.add(key(issueKey, edge));
    },
    has(issueKey, edge) {
      return failed.has(key(issueKey, edge));
    },
  };
}
