import { join } from "node:path";
import type { FailureRecord, SpawnEdgeKind } from "../dispatch/failureLog.js";

/**
 * A session-scoped record of `(issueKey, edge)` spawns that failed to launch, so
 * the level-triggered Reactor stops re-picking-up a rolled-back Issue on the
 * next reconcile and retrying its failed spawn forever (PRD: spawn-failure
 * suppression).
 *
 * One instance is shared across *all three* spawn triggers — the Reactor's
 * auto-spawn and the manual `d`/`r` edges (the CLI constructs it once and injects
 * it into each). A failed launch is a failed launch regardless of who triggered
 * it (ADR 0011): a manual `d`/`r` launch that fails records into, and is
 * subtracted from, the same set the Reactor reads, so it is suppressed from the
 * next reconcile identically to an automated failure.
 *
 * The `issueKey` is opaque to the set — every edge uses each Issue's full path
 * (`prdDir/filename`), not its bare filename, since the Reactor sweeps across
 * every PRD and filenames are only unique within a PRD. Keeping the key opaque
 * here lets each caller own that decision.
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
 * Build a fresh {@link FailedSet}. It is constructed once per board run (by the
 * CLI) and shared across the Reactor and the manual `d`/`r` edges, so it is
 * session-scoped: re-opening the board makes a new set and retries every
 * previously-failed spawn. Spawn failures are transient (a bad binary, a git
 * hiccup), so reopen is the natural — and bounded — retry gesture: a permanent
 * failure re-attempts at most once per session, logged each time.
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

/**
 * Wrap a `logFailure` so the same record a spawn edge appends to the durable log
 * also lands in the shared {@link FailedSet}, keyed by the Issue's full path
 * (`prdDir/filename`) and the failing edge. The {@link FailureRecord} carries
 * only the bare filename, so we re-join it with the edge's `prdDir` — which is
 * exactly each Issue's `path` (the reader builds `path` as `prdDir/filename`), so
 * the record side and the subtract/read sides agree on the key.
 *
 * Shared by all three spawn triggers — the Reactor, the `d` dispatcher, and the
 * `r` reviewer — so a launch failure on any edge records into the one set
 * identically (ADR 0011). Records first, then delegates; both are best-effort and
 * the delegate already never throws.
 */
export function recordingLogFailure(
  failed: FailedSet,
  prdDir: string,
  logFailure: (record: FailureRecord) => void,
): (record: FailureRecord) => void {
  return (record) => {
    failed.record(join(prdDir, record.issueId), record.edge);
    logFailure(record);
  };
}
