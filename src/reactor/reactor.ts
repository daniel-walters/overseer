import { basename } from "node:path";
import { writeStatus } from "../issueFile.js";
import { readDispatchView } from "../dispatch/reader.js";
import { runDispatch, type FailureRecord } from "../dispatch/dispatch.js";
import { featureBranchName, type GitSeam } from "../dispatch/gitSetup.js";
import { buildImplementorPrompt } from "../dispatch/implementorPrompt.js";
import { driveReviewPass } from "../review/review.js";
import { buildReviewerPrompt } from "../review/reviewerPrompt.js";
import {
  DEFAULT_REVIEW_CONFIG,
  type ReviewConfig,
} from "../review/reviewConfig.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import { enumeratePrdDirs } from "./prds.js";
import { sweepFrontier, type PrdInput, type SweptPrd } from "./sweep.js";
import {
  createFailedSet,
  recordingLogFailure,
  type FailedSet,
} from "./failedSet.js";
import { deriveActivity, type ReactorActivity } from "./reactorActivity.js";

// Re-exported so a consumer threading the activity signal through the UI (the
// live loop, the status line) imports the type from the Reactor it reads it off,
// not a second hop through the derivation module.
export type { ReactorActivity } from "./reactorActivity.js";

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
  /**
   * Launch an agent (implementor or reviewer) in `repo` with `prompt`, returning
   * the handle parsed from the launch stdout (or `undefined`); throws on failure.
   */
  readonly spawn: (repo: string, prompt: string) => string | undefined;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /**
   * Record a launched agent's handle — and, on the review edge, the AI-review
   * pass Overseer is driving — against its Issue key in the sidecar (ADR 0008 /
   * 0018). A dispatch spawn omits the pass; a review spawn passes `N+1`.
   */
  readonly recordHandle: (
    issueKey: string,
    handle: string,
    reviewPass?: number,
  ) => void;
  /**
   * Read the AI-review pass recorded for `issueKey` in the sidecar, or
   * `undefined` when none is recorded (a fresh `ready-for-review` Issue whose
   * first pass hasn't spawned yet). The review edge reads this to decide, per
   * reconcile, whether to spawn the next pass (`N < cap`) or escalate at the cap —
   * the count being both the loop control and the card marker (ADR 0018). The CLI
   * projects it off the same sidecar `read` the handle-recorder writes; the
   * Reactor's own unit tests inject a fake. Optional: when omitted, every Issue
   * reads as no recorded pass — the current-behaviour first pass — which is what
   * the Reactor's spawn-edge-wiring tests rely on.
   */
  readonly readReviewPass?: (issueKey: string) => number | undefined;
  /**
   * The session-scoped failed-set the Reactor subtracts from each frontier and
   * records spawn failures into. The CLI constructs one shared instance and
   * injects the *same* set here and into the manual `d`/`r` edges, so a failed
   * launch on any edge suppresses the next reconcile identically (ADR 0011).
   * Optional: when omitted, `createReactor` builds its own — which still makes
   * the set session-scoped (reopen ⇒ fresh set ⇒ failed spawns retried) and is
   * what the Reactor's own unit tests rely on, injecting a recording fake to
   * observe the suppression in isolation.
   */
  readonly failedSet?: FailedSet;
  /**
   * The resolved review knobs (pass cap + effort) the reviewer prompt embeds.
   * The CLI threads {@link import("../config.js").Config.review} here, the *same*
   * value it gives the manual `r` reviewer, so an auto-reviewer's brief is
   * identical to a manual one. Optional: when omitted, the current-behaviour
   * defaults (cap 3, medium) apply, which is what the Reactor's own unit tests
   * (focused on spawn-edge wiring, not prompt contents) rely on.
   */
  readonly review?: ReviewConfig;
}

/** The in-process automation the live loop drives after every board rebuild. */
export interface Reactor {
  /**
   * Sweep every PRD under the root and spawn whatever is eligible on either
   * spawn edge right now — implementors for unblocked `ready-for-agent` Issues,
   * reviewers for `ready-for-review` Issues with a recorded repo — reading only
   * on-disk status (level-triggered, no diffing). A no-op while a reconcile is
   * already in flight, or while auto-run is disabled.
   */
  reconcile(): void;
  /**
   * Turn auto-run on or off — the user-facing brake (`a` keybind). While off,
   * {@link Reactor.reconcile} early-returns and no agents auto-spawn; the user
   * drives the pipeline by hand with `d`/`r`. Enabling from a disabled state
   * immediately reconciles, so the board catches up on everything that became
   * eligible while it was off rather than looking dead until the next filesystem
   * event. In-memory and on by default; not persisted (ADR 0007).
   */
  setEnabled(enabled: boolean): void;
  /**
   * The board-level activity signal — **working** / **idle** / **at-rest** —
   * derived from the Reactor's in-memory state (auto-run on/off plus whether the
   * most recent reconcile spawned). The second surfaced reactor-state overlay,
   * distinct from the auto-run on/off indicator and, like the suppressed marker,
   * never written to the watched root (ADR 0002, ADR 0011). Read by the live loop
   * after each reconcile to drive the status-line indicator. Total: it is a
   * mapping over two in-memory booleans and never throws.
   */
  activity(): ReactorActivity;
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
  // Auto-run state: on by default, in-memory, dies with the instance (ADR 0007).
  // While false, reconcile() early-returns so nothing auto-spawns.
  let enabled = true;
  // Session-scoped. In production the CLI injects the one shared set so a failed
  // launch on any edge (Reactor auto-spawn or manual `d`/`r`) suppresses the next
  // reconcile identically (ADR 0011); reopening the board builds a fresh set and
  // retries. The fallback is for the Reactor's own unit tests, which exercise it
  // in isolation with a recording fake — never the production path.
  const failed = deps.failedSet ?? createFailedSet();
  // The review knobs the reviewer prompt reads; defaults preserve current
  // behaviour (cap 3, medium) when the CLI does not inject config — the path the
  // Reactor's own unit tests take.
  const review = deps.review ?? DEFAULT_REVIEW_CONFIG;
  // Whether the most recent reconcile attempted any spawn — the second input
  // (beside `enabled`) to the board-level activity signal. Starts false so a
  // freshly-opened board with nothing eligible reads `idle` (on, but quiet)
  // rather than a phantom `working` before it has reconciled at all.
  let spawnedLastReconcile = false;

  return {
    setEnabled(next: boolean): void {
      // Catch up on re-enable: a flip from off → on immediately reconciles so the
      // board acts on everything that became eligible while muzzled, rather than
      // waiting for the next filesystem event. Turning off never reconciles.
      const wasOff = !enabled;
      enabled = next;
      if (next && wasOff) this.reconcile();
    },

    activity(): ReactorActivity {
      return deriveActivity({ enabled, spawnedLastReconcile });
    },

    reconcile(): void {
      if (!enabled) return; // auto-run off ⇒ no-op (the user drives with d/r)
      if (reconciling) return; // a reconcile is already running ⇒ no-op
      reconciling = true;
      // Tally spawn *attempts* for this pass: any candidate that reaches the
      // `claude --bg` tip means the Reactor found eligible work and acted, so it
      // is "working" even if that one launch then throws (a failed launch is
      // already surfaced per-card by the suppressed marker — ADR 0011). The
      // counting wrapper sits over `deps.spawn` for the duration of this pass so
      // every edge (`runDispatch`/`runReview`) is counted through one seam.
      let spawnedThisReconcile = false;
      const countingDeps: ReactorDeps = {
        ...deps,
        spawn: (repo, prompt) => {
          spawnedThisReconcile = true;
          return deps.spawn(repo, prompt);
        },
      };
      try {
        for (const swept of sweepFrontier(readPrds(root))) {
          // The PRD's feature branch — the implementor's worktree base and the
          // reviewer's merge target — is derived once here and shared by both
          // edges, so the two can't drift on how it's computed.
          const featureBranch = featureBranchName(basename(swept.prdDir));
          dispatchEligible(swept, featureBranch, countingDeps, failed);
          reviewEligible(swept, featureBranch, countingDeps, failed, review);
        }
      } finally {
        // Publish this pass's tally and always release the guard, even if a path
        // we believed total threw, so a single bad pass can never wedge the
        // Reactor shut or strand a stale activity signal for the session.
        spawnedLastReconcile = spawnedThisReconcile;
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
    logFailure: recordingLogFailure(failed, prdDir, deps.logFailure),
    recordHandle: deps.recordHandle,
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
  review: ReviewConfig,
): void {
  for (const issue of reviewers) {
    if (failed.has(issue.path, "reviewer")) continue; // suppressed this session

    // One pass of the Reactor-owned loop (ADR 0018): `driveReviewPass` reads the
    // pass count off the sidecar and either spawns the next pass (flipping
    // ready-for-review → in-review first, then recording `N+1`) or escalates to
    // human-review with `non-convergence` at the cap. The exact same decision the
    // manual `r` keybind makes — so auto and hand-driven loops step the count
    // identically. When no `readReviewPass` is injected (the Reactor's own
    // spawn-edge-wiring tests), every Issue reads as the first pass.
    driveReviewPass(issue, {
      readReviewPass: deps.readReviewPass ?? (() => undefined),
      review,
      writeStatus,
      buildPrompt: (reviewIssue) =>
        buildReviewerPrompt({
          issue: reviewIssue,
          prdTitle: view.prdTitle,
          prdBody: view.prdBody,
          featureBranch,
          review,
        }),
      spawn: deps.spawn,
      logFailure: recordingLogFailure(failed, prdDir, deps.logFailure),
      recordHandle: deps.recordHandle,
    });
  }
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
