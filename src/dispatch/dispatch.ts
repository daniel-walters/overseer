import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";
import { setUpRepos, type GitSeam } from "./gitSetup.js";
import { Status } from "./status.js";
import { spawnWithFlip, type FailureRecord } from "./failureLog.js";
import type { AgentConfig } from "../agentConfig.js";

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
  /**
   * Launch an implementor in `repo` with the built `prompt`, returning the
   * handle parsed from the launch stdout (or `undefined`). Throws on failure.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /** Record a launched agent's handle against its Issue key in the sidecar. */
  readonly recordHandle: (issueKey: string, handle: string) => void;
  /**
   * The implementor agent runtime (model + effort) every spawn in this dispatch
   * launches at. Optional: omitted ⇒ inherit the launcher's model/effort, the
   * pre-knob behaviour the Reactor's own wiring tests rely on.
   */
  readonly agent?: AgentConfig;
}

/** A spawn candidate the frontier has guaranteed carries a usable repo. */
interface SpawnCandidate {
  readonly issue: DispatchIssue;
  readonly repo: string;
}

/**
 * What a dispatch run actually did, so the caller can report the truth to the
 * user rather than the *intended* spawn count. `launched` is agents that really
 * started; `skipped` is candidates that never started — a repo whose setup
 * failed, or a post-flip launch failure (both already logged + suppressed). The
 * two need not sum to the frontier's spawn count if an Issue file vanished
 * mid-flip, but together they are the honest "what happened" the `d` confirm
 * notice announces instead of "Dispatched N" regardless of outcome.
 */
export interface DispatchResult {
  /** Agents that actually launched. */
  readonly launched: number;
  /** Spawn candidates that did not launch (setup failure or launch failure). */
  readonly skipped: number;
}

/**
 * Run a dispatch over an already-computed frontier, integrating against
 * `featureBranch` (derived once by the caller). The full spawn edge:
 *
 * 1. Validate every distinct spawn-candidate `repo`, ensure the feature branch
 *    in each, and check it out — once per repo, before any agent spawns (so
 *    same-repo Issues don't race on branch setup).
 * 2. For each `spawn` candidate, in order: a candidate whose branch-setup failed
 *    is skipped *and logged* — its setup error is appended to the durable failure
 *    log (which also lands it in the shared failed-set, so the card shows the
 *    `⊘ suppressed` marker). It is never flipped: the failure was pre-flip, so
 *    there is no status to roll back. Otherwise flip the Issue
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
 *
 * Returns a {@link DispatchResult} counting what actually happened — agents
 * launched vs. candidates skipped — so the caller reports the truth rather than
 * the frontier's *intended* spawn count. Before this, a whole dispatch where
 * every repo's checkout failed reported "Dispatched N" yet started nothing and
 * logged nothing; both holes are closed here.
 */
export function runDispatch(
  featureBranch: string,
  frontier: readonly FrontierEntry[],
  deps: DispatchDeps,
): DispatchResult {
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

  let launched = 0;
  let skipped = 0;
  for (const { issue, repo } of candidates) {
    const result = setup.get(repo);
    if (result?.ok !== true) {
      // Pre-flip skip: the repo is invalid or its branch setup failed. Record it
      // to the durable log (which also suppresses the card) so a wave that
      // spawns nothing is never silent — the exact hole that made "Dispatched N
      // but nothing ran" undiagnosable. No rollback: nothing was flipped.
      recordSetupSkip(issue, repo, result?.error, deps.logFailure);
      skipped += 1;
      continue;
    }
    if (spawnOne(issue, repo, deps)) launched += 1;
    else skipped += 1;
  }
  return { launched, skipped };
}

/**
 * Log a candidate skipped because its repo failed setup (invalid repo or a
 * failed branch create/checkout — e.g. a dirty working tree blocking the
 * checkout). Best-effort and never throws, like {@link recordSpawnFailure}: it
 * runs synchronously inside the Ink input handler. The `error` is the setup
 * result's message when present, defaulting otherwise so the log line is always
 * informative.
 */
function recordSetupSkip(
  issue: DispatchIssue,
  repo: string,
  error: string | undefined,
  logFailure: (record: FailureRecord) => void,
): void {
  try {
    logFailure({
      issueId: issue.id,
      repo,
      error: error ?? "repo setup failed",
      edge: "implementor",
    });
  } catch {
    // The durable log is unwritable; losing one skip record must not crash the
    // board or stop later candidates.
  }
}

/**
 * Flip one candidate `ready-for-agent → in-progress` and spawn its implementor,
 * via the shared {@link spawnWithFlip} orchestration (flip-before-spawn with
 * rollback + log on a post-flip failure). The implementor and reviewer edges
 * share that structure so the lock-and-rollback contract can't drift between
 * them. Returns whether the agent actually launched, so the caller's count
 * reflects launches, not attempts.
 */
function spawnOne(
  issue: DispatchIssue,
  repo: string,
  deps: DispatchDeps,
): boolean {
  return spawnWithFlip({
    edge: "implementor",
    issue,
    repo,
    awaiting: Status.READY_FOR_AGENT,
    active: Status.IN_PROGRESS,
    writeStatus: deps.writeStatus,
    buildPrompt: () => deps.buildPrompt(issue, repo),
    spawn: deps.spawn,
    agent: deps.agent,
    logFailure: deps.logFailure,
    recordHandle: deps.recordHandle,
  });
}
