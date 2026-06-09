import { basename } from "node:path";
import { writeStatus } from "../issueFile.js";
import { readDispatchView } from "../dispatch/reader.js";
import { runDispatch, type FailureRecord } from "../dispatch/dispatch.js";
import { featureBranchName, type GitSeam } from "../dispatch/gitSetup.js";
import { buildImplementorPrompt } from "../dispatch/implementorPrompt.js";
import { enumeratePrdDirs } from "./prds.js";
import { sweepImplementorFrontier, type PrdInput } from "./sweep.js";

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
 * This slice covers the implementor edge only; the reviewer auto-spawn and the
 * failed-set suppression build on top in later slices.
 */
export function createReactor(root: string, deps: ReactorDeps): Reactor {
  /** True while a reconcile is in flight; the re-entrancy guard reads it. */
  let reconciling = false;

  return {
    reconcile(): void {
      if (reconciling) return; // a reconcile is already running ⇒ no-op
      reconciling = true;
      try {
        dispatchEligible(readPrds(root), deps);
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
 * Run the existing `runDispatch` spawn edge over each PRD's swept frontier.
 * `runDispatch` itself takes only the `spawn`-classified entries, flips each off
 * `ready-for-agent` before spawning, and rolls back + logs any post-flip
 * failure — none of which throws — so the loop is total.
 */
function dispatchEligible(prds: readonly PrdInput[], deps: ReactorDeps): void {
  for (const { prdDir, view, frontier } of sweepImplementorFrontier(prds)) {
    const featureBranch = featureBranchName(basename(prdDir));
    runDispatch(featureBranch, frontier, {
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
      logFailure: deps.logFailure,
    });
  }
}
