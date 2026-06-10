import { basename, join } from "node:path";
import { writeStatus } from "../issueFile.js";
import { readDispatchView } from "../dispatch/reader.js";
import { runDispatch, type FailureRecord } from "../dispatch/dispatch.js";
import { featureBranchName, type GitSeam } from "../dispatch/gitSetup.js";
import { buildImplementorPrompt } from "../dispatch/implementorPrompt.js";
import { runReview } from "../review/review.js";
import { buildReviewerPrompt } from "../review/reviewerPrompt.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import { enumeratePrdDirs } from "./prds.js";
import { sweepFrontier, type PrdInput, type SweptPrd } from "./sweep.js";
import { createFailedSet, type FailedSet } from "./failedSet.js";

/**
 * The I/O seams the Reactor injects into both spawn edges — the *same* the
 * dispatcher and reviewer take, so automated and manual (`d`/`r`) spawns use
 * identical validated git/spawn/log machinery (the CLI wires all three from one
 * `createSpawnEdge`). The `git` seam is the implementor edge's branch setup;
 * the reviewer edge needs no git seam (it merges into the existing feature
 * branch itself). The status-writer and prompt builders are not seams here
 * either: they are pure/fs-internal and exercised by their own modules.
 */
export interface ReactorDeps {
  /** Validate repos and ensure the per-repo PRD feature branch (implementor edge). */
  readonly git: GitSeam;
  /** Launch an agent (implementor or reviewer) in `repo` with `prompt`; throws on failure. */
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
   * Sweep every PRD under the root and spawn whatever is eligible on either
   * spawn edge right now — implementors for unblocked `ready-for-agent` Issues,
   * reviewers for `ready-for-review` Issues with a recorded repo — reading only
   * on-disk status (level-triggered, no diffing). A no-op while a reconcile is
   * already in flight.
   */
  reconcile(): void;
}

/**
 * Build the Reactor: in-process automation that closes the pipeline's two
 * spawn-edge loops (ADR 0005). On each {@link Reactor.reconcile} it enumerates
 * every PRD under `root`, reads each PRD's dispatch view, computes the cross-PRD
 * frontier (reusing `computeFrontier` via the sweep), and runs the existing
 * `runDispatch`/`runReview` per PRD — the very spawn edges the `d` and `r`
 * keybinds use, sharing the same `git`/`spawn`/`logFailure` seams.
 *
 * Both spawn edges run in one pass:
 *
 * - **Implementor** for any `ready-for-agent` Issue whose blockers are all
 *   `done`. So completing one Issue's `done` unblocks its siblings, and the next
 *   reconcile dispatches them: one `d` cascades through the dependency graph with
 *   no second keypress.
 * - **Reviewer** for any `ready-for-review` Issue with a recorded repo. So a
 *   reviewer reaching `done` re-dispatches the newly-unblocked siblings on the
 *   next pass, and any fresh `ready-for-review` Issue gets a reviewer with no `r`
 *   press — the pipeline cascades implement → review → done → re-dispatch
 *   unattended after a single `d`.
 *
 * These are the two — and only two — spawn edges (CONTEXT.md → Status
 * lifecycle); the Reactor never spawns on an agent-owned transition or a human
 * gate. It sits *beside* `createDispatcher`/`createReviewer`, not on top of
 * them: it reuses only the spawn-edge cores (`runDispatch`/`runReview`),
 * deliberately not their preview/`lastRead` caching, which is a human-flow
 * concern and a re-entrancy footgun in a sweep.
 *
 * Three invariants keep it safe:
 *
 * - **Re-entrancy guard.** A reconcile that fires while one is already running
 *   is a no-op. This is for clean logs / no redundant work, not correctness —
 *   flip-before-spawn (ADR 0002) is the real lock: each edge flips an Issue off
 *   its awaiting status before spawning, so overlapping passes can't
 *   double-spawn even without the guard.
 * - **Totality.** Every path is total — a vanished/unreadable PRD during the
 *   sweep is skipped, and no Reactor code may throw out of the watcher callback
 *   and crash the board. This matches the dispatcher/reviewer contract.
 * - **Spawn-failure suppression.** A spawn that fails to launch is rolled back to
 *   its awaiting status and logged by the spawn edge (unchanged) *and* recorded
 *   in a session-scoped {@link FailedSet} keyed by `(issueKey, edge)`. The
 *   reconcile subtracts that set from each swept frontier — on *both* edges — so
 *   a rolled-back Issue (still `ready-for-agent`/`ready-for-review` on disk) is
 *   not re-picked-up and retried forever. The set is built per instance, so a
 *   fresh board (reopen) retries: a permanent failure re-attempts at most once
 *   per session, logged each time, never routed to `human-review`. The edge key
 *   keeps an implementor failure from masking the reviewer edge for the same
 *   Issue, and vice versa.
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
        for (const swept of sweepFrontier(readPrds(root))) {
          // Per-PRD boundary: one PRD's unexpected throw skips that PRD rather
          // than escaping reconcile() into the unguarded watcher callback and
          // crashing the board — matching readPrds' per-PRD resilience. The
          // spawn edges are built total, so this never fires today; it is the
          // structural backstop that keeps the watcher-callback totality from
          // resting on every transitive callee staying total forever (e.g. the
          // recursive cycle-detection in computeFrontier overflowing the stack
          // on a pathological blocked_by chain). The other PRDs still reconcile.
          try {
            // The PRD's feature branch — the implementor's worktree base and the
            // reviewer's merge target — is derived once here and shared by both
            // edges, so the two can't drift on how it's computed.
            const featureBranch = featureBranchName(basename(swept.prdDir));
            dispatchEligible(swept, featureBranch, deps, failed);
            reviewEligible(swept, featureBranch, deps, failed);
          } catch {
            // Skip this PRD this pass; the next reconcile retries it.
          }
        }
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
 * Run the existing `runDispatch` spawn edge over one PRD's swept frontier, minus
 * the failed-set. `runDispatch` itself takes only the `spawn`-classified
 * entries, flips each off `ready-for-agent` before spawning, and rolls back +
 * logs any post-flip failure — none of which throws — so the loop is total.
 *
 * Two failed-set integrations sit around that unchanged edge:
 *
 * - **Subtract.** Drop any `spawn` entry whose `(path, implementor)` is already
 *   recorded, so an Issue rolled back by an earlier failed launch — still
 *   `ready-for-agent` on disk — is not re-spawned this pass.
 * - **Record.** Wrap `logFailure` so the same record the edge appends to the
 *   durable log also lands in the failed-set ({@link recordingLogFailure}).
 *
 * Both sides key the set by the Issue's *full path* (`prdDir/filename`), not its
 * bare filename: the Reactor sweeps across every PRD, and Issue filenames are
 * only unique within a PRD, so a bare-filename key would let a failure in one
 * PRD suppress a same-named Issue in another.
 */
function dispatchEligible(
  { prdDir, view, frontier }: SweptPrd,
  featureBranch: string,
  deps: ReactorDeps,
  failed: FailedSet,
): void {
  runDispatch(featureBranch, subtractFailedImplementors(frontier, failed), {
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
    logFailure: recordingLogFailure(prdDir, deps, failed),
  });
}

/**
 * Run the existing `runReview` spawn edge over one PRD's reviewer candidates,
 * minus the failed-set — the second of the two spawn edges. Each candidate is
 * `ready-for-review` and reviewable (the sweep gated that via the shared
 * `classifyReviewability`); `runReview` flips it `ready-for-review → in-review`
 * before spawning, so flip-before-spawn is the idempotency lock here exactly as
 * it is for the implementor edge, and rolls back + logs any post-flip failure
 * under the `reviewer` edge label. Reuses the same `spawn`/`logFailure` seams as
 * the implementor edge — and as the `r` keybind's reviewer — so automated and
 * manual reviews behave identically.
 *
 * The same failed-set suppression wraps this edge: a reviewer candidate already
 * recorded as a failed `reviewer` spawn this session is skipped (so a rolled-back
 * `ready-for-review` Issue is not retried forever), and any new reviewer-spawn
 * failure is recorded under the `reviewer` edge key. Keyed by full path and by
 * edge, so it never masks the implementor edge for the same Issue.
 *
 * Like the dispatch loop, this never throws: `runReview` is total (a vanished
 * Issue file or unwritable log is swallowed), so a reviewer-edge failure can't
 * crash the board or suppress the other PRDs' spawns.
 */
function reviewEligible(
  { prdDir, view, reviewers }: SweptPrd,
  featureBranch: string,
  deps: ReactorDeps,
  failed: FailedSet,
): void {
  for (const issue of reviewers) {
    if (failed.has(issue.path, "reviewer")) continue; // suppressed this session
    runReview(issue, {
      writeStatus,
      buildPrompt: (reviewIssue) =>
        buildReviewerPrompt({
          issue: reviewIssue,
          prdTitle: view.prdTitle,
          prdBody: view.prdBody,
          featureBranch,
        }),
      spawn: deps.spawn,
      logFailure: recordingLogFailure(prdDir, deps, failed),
    });
  }
}

/**
 * Wrap `deps.logFailure` so the same record the spawn edge appends to the
 * durable log also lands in the failed-set, keyed by the Issue's full path
 * (`prdDir/filename`) and the failing edge. The record carries only the bare
 * filename, so we re-join it with this PRD's `prdDir` — which is exactly
 * `issue.path` (the reader builds `path` as `prdDir/filename`), so the record
 * and subtract sides agree on the key. Records first, then delegates; both are
 * best-effort and the delegate already never throws.
 */
function recordingLogFailure(
  prdDir: string,
  deps: ReactorDeps,
  failed: FailedSet,
): (record: FailureRecord) => void {
  return (record) => {
    failed.record(join(prdDir, record.issueId), record.edge);
    deps.logFailure(record);
  };
}

/**
 * Subtract the failed-set from one PRD's frontier: drop every `spawn`-classified
 * entry whose implementor edge has already failed this session, keyed by the
 * Issue's full path so the suppression is per-PRD (see {@link recordingLogFailure}).
 * Non-`spawn` entries pass through untouched — `runDispatch` ignores them anyway,
 * and keeping them keeps the frontier shape intact for any future caller.
 */
function subtractFailedImplementors(
  frontier: readonly FrontierEntry[],
  failed: FailedSet,
): readonly FrontierEntry[] {
  return frontier.filter(
    (e) =>
      e.classification !== "spawn" || !failed.has(e.issue.path, "implementor"),
  );
}
