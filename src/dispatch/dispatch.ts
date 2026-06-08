import type { FrontierEntry } from "./frontier.js";
import type { DispatchIssue } from "./reader.js";

/**
 * The I/O seams a dispatch run depends on, injected so the orchestration can be
 * tested without touching the filesystem or spawning real agents.
 *
 * In production `writeStatus` is the status-writer and `spawn` is the real
 * spawn tip (validate repo, ensure branch, shell out to `claude --bg`). In this
 * tracer-bullet slice `spawn` is a stub injected from the UI — the keypress →
 * status-flip → live-board path is proven before any real agent runs.
 */
export interface DispatchDeps {
  /** Rewrite an Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /** Start an implementor for one spawn-candidate Issue. */
  readonly spawn: (issue: DispatchIssue) => void;
}

const IN_PROGRESS = "in-progress";

/**
 * Run a dispatch over an already-computed frontier: for each `spawn` candidate,
 * in order, flip the Issue `ready-for-agent → in-progress` *before* spawning it,
 * then spawn it. Non-spawn entries (queued/blocked/skipped) are left untouched.
 *
 * Flipping before spawning is what makes re-dispatch and second instances safe:
 * the status itself is the lock, so by the time the next candidate is considered
 * this one is already off the `ready-for-agent` frontier.
 *
 * The flip is the spawn's precondition: if it fails — the file vanished from the
 * watched root between preview and confirm, say — that candidate is skipped (no
 * spawn) and the wave continues. One unwritable Issue never aborts the rest, and
 * a never-flipped Issue is never handed to an agent.
 */
export function runDispatch(
  frontier: readonly FrontierEntry[],
  deps: DispatchDeps,
): void {
  for (const { issue, classification } of frontier) {
    if (classification !== "spawn") continue;
    try {
      deps.writeStatus(issue.path, IN_PROGRESS);
    } catch {
      continue; // flip failed ⇒ precondition unmet ⇒ do not spawn
    }
    deps.spawn(issue);
  }
}
