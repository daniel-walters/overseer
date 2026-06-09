import { basename } from "node:path";
import { writeStatus } from "../issueFile.js";
import { readDispatchView } from "../dispatch/reader.js";
import { runDispatch, type FailureRecord } from "../dispatch/dispatch.js";
import { featureBranchName, type GitSeam } from "../dispatch/gitSetup.js";
import { buildImplementorPrompt } from "../dispatch/implementorPrompt.js";
import { enumeratePrdDirs } from "./prds.js";
import { sweepImplementorFrontier, type PrdInput } from "./sweep.js";
import { createFailedSet, type FailedSet } from "./failedSet.js";
import type { FrontierEntry } from "../dispatch/frontier.js";

/**
 * The I/O seams the Reactor injects into the spawn edge — the *same* three the
 * dispatcher takes, so automated and manual (`d`) spawns use identical validated
 * git/spawn/log machinery (the CLI wires both from one `createSpawnEdge`). The
 * status-writer and prompt builder are not seams here either: they are
 * pure/fs-internal and exercised by their own modules.
 */
export interface ReactorDeps {
  /** Validate repos and ensure the per-repo PRD feature branch. */
  readonly git: GitSeam;
  /** Launch an implementor in `repo` with `prompt`; throws if the launch fails. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /**
   * The session-scoped failed-set the Reactor subtracts from each frontier and
   * records spawn failures into. Optional: the production caller omits it and
   * each `createReactor` builds its own, which is what makes the set
   * session-scoped (reopen ⇒ fresh set ⇒ failed spawns retried). Tests inject a
   * recording fake to observe the suppression.
   */
  readonly failedSet?: FailedSet;
}

/** The in-process automation the live loop drives after every board rebuild. */
export interface Reactor {
  /**
   * Sweep every PRD under the root and dispatch whatever is implementor-spawn
   * eligible right now, reading only on-disk status (level-triggered, no
   * diffing). A no-op while a reconcile is already in flight.
   */
  reconcile(): void;
}

/**
 * Build the Reactor: in-process automation that closes the re-dispatch loop on
 * the implementor edge (ADR 0005). On each {@link Reactor.reconcile} it
 * enumerates every PRD under `root`, reads each PRD's dispatch view, computes the
 * cross-PRD implementor frontier (reusing `computeFrontier` via the sweep), and
 * runs the existing `runDispatch` per PRD — the very spawn edge the `d` keybind
 * uses, sharing the same `git`/`spawn`/`logFailure` seams. So completing one
 * Issue's `done` unblocks its siblings, and the next reconcile dispatches them:
 * one `d` cascades through the dependency graph with no second keypress.
 *
 * It sits *beside* `createDispatcher`/`createReviewer`, not on top of them: it
 * reuses only the spawn-edge core (`runDispatch`), deliberately not their
 * preview/`lastRead` caching, which is a human-flow concern and a re-entrancy
 * footgun in a sweep.
 *
 * Two invariants keep it safe:
 *
 * - **Re-entrancy guard.** A reconcile that fires while one is already running
 *   is a no-op. This is for clean logs / no redundant work, not correctness —
 *   flip-before-spawn (ADR 0002) is the real lock: `runDispatch` flips an Issue
 *   off `ready-for-agent` before spawning, so overlapping passes can't
 *   double-spawn even without the guard.
 * - **Totality.** Every path is total — a vanished/unreadable PRD during the
 *   sweep is skipped, and no Reactor code may throw out of the watcher callback
 *   and crash the board. This matches the dispatcher/reviewer contract.
 *
 * **Spawn-failure suppression.** A spawn that fails to launch is rolled back to
 * `ready-for-agent` and logged by the spawn edge (unchanged) *and* recorded in a
 * session-scoped {@link FailedSet} keyed by `(issueId, edge)`. The reconcile
 * subtracts that set from each swept frontier, so a rolled-back Issue — still
 * `ready-for-agent` on disk — is not re-picked-up and retried forever. The set
 * is built per instance, so a fresh board (reopen) retries: a permanent failure
 * re-attempts at most once per session, logged each time, never routed to
 * `human-review`.
 *
 * This slice covers the implementor edge only; once the reviewer auto-spawn
 * lands, the edge-keyed failed-set covers it with no further change.
 */
export function createReactor(root: string, deps: ReactorDeps): Reactor {
  /** True while a reconcile is in flight; the re-entrancy guard reads it. */
  let reconciling = false;
  // Session-scoped: one set per Reactor instance. The production caller omits
  // `deps.failedSet`, so reopening the board builds a fresh set and retries.
  const failed = deps.failedSet ?? createFailedSet();

  return {
    reconcile(): void {
      if (reconciling) return; // a reconcile is already running ⇒ no-op
      reconciling = true;
      try {
        dispatchEligible(readPrds(root), deps, failed);
      } finally {
        // Always release the guard, even if a path we believed total threw, so a
        // single bad pass can never wedge the Reactor shut for the session.
        reconciling = false;
      }
    },
  };
}

/**
 * Read every PRD under `root` into a {@link PrdInput}, skipping any that vanish
 * or are unreadable mid-sweep (the readers throw; we drop that PRD rather than
 * abort the whole reconcile). The root being unreadable yields no PRDs — handled
 * by the enumerator — so the watcher callback never sees a throw from here.
 */
function readPrds(root: string): PrdInput[] {
  const prds: PrdInput[] = [];
  for (const prdDir of enumeratePrdDirs(root)) {
    try {
      prds.push({ prdDir, view: readDispatchView(prdDir) });
    } catch {
      // The PRD dir or one of its files vanished/became unreadable between
      // enumeration and read. Skip it; the next reconcile retries.
    }
  }
  return prds;
}

/**
 * Run the existing `runDispatch` spawn edge over each PRD's swept frontier,
 * minus the failed-set. `runDispatch` itself takes only the `spawn`-classified
 * entries, flips each off `ready-for-agent` before spawning, and rolls back +
 * logs any post-flip failure — none of which throws — so the loop is total.
 *
 * Two failed-set integrations sit around that unchanged edge:
 *
 * - **Subtract.** Drop any `spawn` entry whose `(issueId, implementor)` is
 *   already recorded, so an Issue rolled back by an earlier failed launch — still
 *   `ready-for-agent` on disk — is not re-spawned this pass.
 * - **Record.** Wrap `logFailure` so the same record the edge appends to the
 *   durable log also lands in the failed-set, keyed by its `issueId` and `edge`.
 *   The wrap records first, then delegates; both are best-effort and the
 *   delegate already never throws.
 */
function dispatchEligible(
  prds: readonly PrdInput[],
  deps: ReactorDeps,
  failed: FailedSet,
): void {
  for (const { prdDir, view, frontier } of sweepImplementorFrontier(prds)) {
    const featureBranch = featureBranchName(basename(prdDir));
    runDispatch(featureBranch, subtractFailed(frontier, failed), {
      git: deps.git,
      writeStatus,
      buildPrompt: (issue, repo) =>
        buildImplementorPrompt({
          issue,
          prdTitle: view.prdTitle,
          prdBody: view.prdBody,
          repo,
          featureBranch,
        }),
      spawn: deps.spawn,
      logFailure: (record) => {
        failed.record(record.issueId, record.edge);
        deps.logFailure(record);
      },
    });
  }
}

/**
 * Subtract the failed-set from one PRD's frontier: drop every `spawn`-classified
 * entry whose implementor edge has already failed this session. Non-`spawn`
 * entries pass through untouched — `runDispatch` ignores them anyway, and
 * keeping them keeps the frontier shape intact for any future caller.
 */
function subtractFailed(
  frontier: readonly FrontierEntry[],
  failed: FailedSet,
): readonly FrontierEntry[] {
  return frontier.filter(
    (e) =>
      e.classification !== "spawn" ||
      !failed.has(e.issue.id, "implementor"),
  );
}
