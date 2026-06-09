import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";
import { setUpRepos, type GitSeam } from "./gitSetup.js";
import { Status } from "./status.js";
import { spawnWithFlip, type FailureRecord } from "./failureLog.js";

// Re-exported so existing importers (spawn.ts, dispatcher.ts, the review edge)
// keep their `from "./dispatch.js"` import; the type now lives with the shared
// failure-log helpers it travels with.
export type { FailureRecord, SpawnEdgeKind } from "./failureLog.js";

/**
 * The I/O seams a dispatch run depends on, injected so the orchestration can be
 * tested without touching the filesystem, git, or spawning real agents.
 *
 * In production these are the real status-writer, git seam, prompt builder, the
 * `claude --bg` spawn tip, and the failure-log appender. In tests they are
 * recording fakes (mirroring the watcher's `createWatcher` seam).
 */
export interface DispatchDeps {
  /** Validate repos and ensure the per-repo PRD feature branch. */
  readonly git: GitSeam;
  /** Rewrite an Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /** Build the implementor prompt for one spawn-candidate Issue in `repo`. */
  readonly buildPrompt: (issue: DispatchIssue, repo: string) => string;
  /** Launch an implementor agent in `repo` with the built `prompt`. Throws on failure. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
}

/** A spawn candidate the frontier has guaranteed carries a usable repo. */
interface SpawnCandidate {
  readonly issue: DispatchIssue;
  readonly repo: string;
}

/**
 * Run a dispatch over an already-computed frontier, integrating against
 * `featureBranch` (derived once by the caller). The full spawn edge:
 *
 * 1. Validate every distinct spawn-candidate `repo`, ensure the feature branch
 *    in each, and check it out — once per repo, before any agent spawns (so
 *    same-repo Issues don't race on branch setup).
 * 2. For each `spawn` candidate, in order: skip (never flip, never log) any
 *    whose branch-setup failed — that is a pre-spawn skip surfaced by the modal
 *    preview, not a launch failure. Otherwise flip the Issue
 *    `ready-for-agent → in-progress` *before* spawning, build its prompt, and
 *    spawn `claude --bg` in its repo.
 * 3. If a spawn throws *after* the flip, roll the Issue back to
 *    `ready-for-agent` (so the board never shows in-progress work with no agent)
 *    and append a record to the durable failure log.
 *
 * Flipping before spawning is what makes re-dispatch and second instances safe:
 * the status itself is the lock, so by the time the next candidate is considered
 * this one is already off the `ready-for-agent` frontier. A single failed
 * candidate never aborts the wave.
 */
export function runDispatch(
  featureBranch: string,
  frontier: readonly FrontierEntry[],
  deps: DispatchDeps,
): void {
  // The frontier guarantees a `spawn` entry has a non-empty repo; narrow to that
  // here so the rest of the edge never has to invent a default repo value.
  const candidates: SpawnCandidate[] = frontier
    .filter((e) => e.classification === "spawn")
    .map((e) => e.issue)
    .filter((issue): issue is DispatchIssue & { repo: string } => !!issue.repo)
    .map((issue) => ({ issue, repo: issue.repo }));

  const setup = setUpRepos(
    featureBranch,
    candidates.map((c) => c.repo),
    deps.git,
  );

  for (const { issue, repo } of candidates) {
    if (setup.get(repo)?.ok !== true) {
      continue; // invalid repo or failed branch setup: skip-and-report
    }
    spawnOne(issue, repo, deps);
  }
}

/**
 * Flip one candidate `ready-for-agent → in-progress` and spawn its implementor,
 * via the shared {@link spawnWithFlip} orchestration (flip-before-spawn with
 * rollback + log on a post-flip failure). The implementor and reviewer edges
 * share that structure so the lock-and-rollback contract can't drift between
 * them.
 */
function spawnOne(
  issue: DispatchIssue,
  repo: string,
  deps: DispatchDeps,
): void {
  spawnWithFlip({
    edge: "implementor",
    issue,
    repo,
    awaiting: Status.READY_FOR_AGENT,
    active: Status.IN_PROGRESS,
    writeStatus: deps.writeStatus,
    buildPrompt: () => deps.buildPrompt(issue, repo),
    spawn: deps.spawn,
    logFailure: deps.logFailure,
  });
}
