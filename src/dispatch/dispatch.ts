import { basename } from "node:path";
import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";
import { setUpRepos, type GitSeam } from "./gitSetup.js";

/** A spawn-failure record appended to the durable dispatch log. */
export interface FailureRecord {
  /** The Issue filename whose agent failed to launch. */
  readonly issueId: string;
  /** The target repo the agent would have worked in. */
  readonly repo: string;
  /** The error message from the failed spawn. */
  readonly error: string;
}

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
  /** Build the implementor prompt for one spawn-candidate Issue. */
  readonly buildPrompt: (issue: DispatchIssue) => string;
  /** Launch an implementor agent in `repo` with the built `prompt`. Throws on failure. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
}

const READY_FOR_AGENT = "ready-for-agent";
const IN_PROGRESS = "in-progress";

/**
 * Run a dispatch over an already-computed frontier. The full spawn edge:
 *
 * 1. Validate every distinct spawn-candidate `repo` and ensure the PRD feature
 *    branch in each — once per repo, before any agent spawns (so same-repo
 *    Issues don't race on branch creation).
 * 2. For each `spawn` candidate, in order: skip (never flip, never log) any
 *    whose repo is missing/invalid or whose branch-ensure failed — that is a
 *    pre-spawn skip surfaced by the modal preview, not a launch failure.
 *    Otherwise flip the Issue `ready-for-agent → in-progress` *before* spawning,
 *    build its prompt, and spawn `claude --bg` in its repo.
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
  prdDir: string,
  frontier: readonly FrontierEntry[],
  deps: DispatchDeps,
): void {
  const candidates = frontier
    .filter((e) => e.classification === "spawn")
    .map((e) => e.issue);

  // A spawn candidate always carries a repo (the frontier skips missing/invalid
  // ones), but guard defensively: an undefined repo is treated as a skip below.
  const repos = candidates
    .map((issue) => issue.repo)
    .filter((repo): repo is string => repo !== undefined);

  const setup = setUpRepos(basename(prdDir), repos, deps.git);

  for (const issue of candidates) {
    if (issue.repo === undefined || setup.get(issue.repo)?.ok !== true) {
      continue; // missing/invalid repo or failed branch setup: skip-and-report
    }
    spawnOne(issue, issue.repo, deps);
  }
}

/**
 * Flip one candidate to `in-progress` and spawn its agent. A flip failure (the
 * file vanished from the watched root) skips the spawn with no rollback or log —
 * nothing was started. A spawn failure *after* the flip rolls the status back
 * and records the failure.
 */
function spawnOne(
  issue: DispatchIssue,
  repo: string,
  deps: DispatchDeps,
): void {
  try {
    deps.writeStatus(issue.path, IN_PROGRESS);
  } catch {
    return; // flip failed: nothing was started, so nothing to roll back or log
  }

  try {
    deps.spawn(repo, deps.buildPrompt(issue));
  } catch (err) {
    deps.writeStatus(issue.path, READY_FOR_AGENT);
    deps.logFailure({ issueId: issue.id, repo, error: errorMessage(err) });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
