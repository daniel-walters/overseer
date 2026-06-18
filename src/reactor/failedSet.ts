import { join } from "node:path";
import type { FailedEdgeKind, FailureRecord } from "../dispatch/failureLog.js";
import type { SuppressedLookup } from "../scanner.js";

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
 * implementor edge for that Issue, never the reviewer edge (or the non-spawn
 * `resolve` edge — ADR 0019) for the same Issue, so one failing edge can't mask a
 * legitimate later spawn or resolve on another. The Reactor subtracts this set
 * from each swept frontier (and the verdict frontier) and records into it on a
 * spawn launch failure or a transient merge failure.
 */
export interface FailedSet {
  /** Mark `(issueKey, edge)` as a failed spawn/resolve for the rest of this session. */
  record(issueKey: string, edge: FailedEdgeKind): void;
  /** Whether `(issueKey, edge)` has been recorded as a failed spawn/resolve. */
  has(issueKey: string, edge: FailedEdgeKind): boolean;
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
  const key = (issueKey: string, edge: FailedEdgeKind): string =>
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
 * Project a {@link FailedSet} to its {@link SuppressedLookup} — the narrow,
 * read-only seam handed to the board: answer "is `(path, edge)` suppressed?" and
 * nothing else, to decide whether a card carries the `⊘ suppressed` marker.
 *
 * It deliberately exposes *only* the read. Only the spawn edges write the set;
 * the board only observes it (ADR 0011), so the board must never receive the raw
 * {@link FailedSet} (which carries the writable `record`). It gets this function
 * instead, which closes over only the set's `has`, so the writable `record` is
 * unreachable through the returned function — the board can ask whether a
 * `(path, edge)` is suppressed but holds no reference that lets it record one.
 *
 * Total by construction — it is just a `boolean` query over a `Set`, so an absent
 * or empty set yields `false` for every pair and nothing here can throw. The
 * seam's shape is the scanner's published overlay contract ({@link
 * SuppressedLookup}, the sibling of `LivenessLookup`), imported rather than
 * re-declared so the contract lives in exactly one place — the consumer that
 * defines it.
 */
export function suppressedSeam(failed: FailedSet): SuppressedLookup {
  return (path, edge) => failed.has(path, edge);
}

/**
 * Wrap a `logFailure` so the same record a spawn edge appends to the durable log
 * also lands in the shared {@link FailedSet}, keyed by the Issue's full path
 * (`prdDir/filename`) and the failing edge. The {@link FailureRecord} carries
 * only the bare filename, so we re-join it with the edge's `prdDir` — which is
 * exactly each Issue's `path` (the reader builds `path` as `prdDir/filename`), so
 * the record side and the subtract/read sides agree on the key.
 *
 * Shared by all the failure-recording edges — the Reactor, the `d` dispatcher,
 * the `r` reviewer, and the non-spawn `resolve` edge (ADR 0019) — so a launch or
 * transient-merge failure on any edge records into the one set identically (ADR
 * 0011). The edge is read off the {@link FailureRecord} (`implementor` /
 * `reviewer` / `resolve`), so the same wrapper keys every edge correctly. Records
 * first, then delegates; both are best-effort and the delegate already never throws.
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
