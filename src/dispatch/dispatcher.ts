import { basename, join } from "node:path";
import { computeFrontier, type FrontierEntry } from "./frontier.js";
import { readDispatchView, type DispatchView } from "./reader.js";
import { writeStatus } from "../issueFile.js";
import { runDispatch, type FailureRecord } from "./dispatch.js";
import { featureBranchName, type GitSeam } from "./gitSetup.js";
import { buildImplementorPrompt } from "./implementorPrompt.js";
import { recordingLogFailure, type FailedSet } from "../reactor/failedSet.js";
import type { Dispatcher } from "../ui/App.js";

/**
 * The I/O seams the production dispatcher injects into {@link runDispatch},
 * passed in by the CLI so dispatch is tested without real git or Claude. The
 * status-writer and prompt builder are not seams — they are pure/fs-internal and
 * exercised by their own modules — so only the genuinely external edges (git,
 * the `claude --bg` spawn, the failure log) are injected here.
 */
export interface DispatcherDeps {
  /** Validate repos and ensure the per-repo PRD feature branch. */
  readonly git: GitSeam;
  /**
   * Launch an implementor in `repo` with `prompt`, returning the handle parsed
   * from the launch stdout (or `undefined`); throws if the launch fails.
   */
  readonly spawn: (repo: string, prompt: string) => string | undefined;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /** Record a launched agent's handle against its Issue key in the sidecar. */
  readonly recordHandle: (issueKey: string, handle: string) => void;
  /**
   * The session-scoped failed-set shared with the Reactor and the reviewer. A
   * manual `d` launch that fails records `(path, implementor)` here, so the next
   * Reactor reconcile subtracts that Issue and does not re-spawn it this session
   * — a failed launch is a failed launch regardless of who triggered it (ADR
   * 0011). The CLI injects the one shared instance.
   */
  readonly failedSet: FailedSet;
}

/**
 * Build the production {@link Dispatcher} the App drives. It resolves a PRD id to
 * its directory under `root`, reads + classifies its frontier for the preview,
 * and on confirm runs the real spawn edge over that frontier: validate each
 * repo, ensure the PRD feature branch, flip each spawn candidate to
 * `in-progress`, build its implementor prompt, and spawn `claude --bg` in its
 * repo — rolling back and logging any post-flip spawn failure.
 *
 * `readFrontier` caches the {@link DispatchView} it read so `dispatch` can build
 * prompts (which need the PRD body and feature branch) without re-reading the
 * root — the App always confirms the very frontier it just previewed.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI by design, so `d` and confirm can race a deletion. `readFrontier`
 * reports an unreadable PRD as an empty frontier (the preview renders "nothing
 * to spawn"), and the flip-then-spawn loop skips any Issue whose flip fails —
 * neither path is allowed to throw out of the Ink input handler and crash the
 * board.
 */
export function createDispatcher(
  root: string,
  deps: DispatcherDeps,
): Dispatcher {
  /** The PRD dir + view behind the last frontier read, for prompt building. */
  let lastRead: { prdDir: string; view: DispatchView } | undefined;

  return {
    readFrontier(prdId: string): readonly FrontierEntry[] {
      const prdDir = join(root, prdId);
      try {
        const view = readDispatchView(prdDir);
        lastRead = { prdDir, view };
        return computeFrontier(view);
      } catch {
        lastRead = undefined;
        return []; // PRD dir/files vanished from the watched root ⇒ empty plan
      }
    },

    hasDispatchable(prdId: string): boolean {
      // The side-effect-free peek the status-line hints read each render to gate
      // `d` (ADR 0017): whether the PRD's frontier holds ≥1 spawn candidate.
      // Deliberately does NOT touch `lastRead` — unlike `readFrontier`, it never
      // re-points the cached view a pending `d` confirm acts on, so the hints can
      // call it every render without clobbering an open dispatch preview's plan. A
      // vanished/unreadable PRD reports no dispatchable work (total, like
      // `readFrontier`), so the hint simply hides `d` rather than throwing out of
      // the Ink render and crashing the board.
      try {
        return computeFrontier(readDispatchView(join(root, prdId))).some(
          (e) => e.classification === "spawn",
        );
      } catch {
        return false;
      }
    },

    dispatch(frontier: readonly FrontierEntry[]): void {
      if (lastRead === undefined) return; // nothing was read ⇒ nothing to dispatch
      const { prdDir, view } = lastRead;
      // Derive the feature branch once and thread it through both the branch
      // setup (in runDispatch) and the prompt, so they can never disagree.
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
        // Route this manual `d` launch's failures through the shared failed-set
        // (keyed by the Issue's full path, prdDir/filename) before the durable
        // log, so a failed manual dispatch is suppressed from the next Reactor
        // reconcile exactly as an automated one is.
        logFailure: recordingLogFailure(deps.failedSet, prdDir, deps.logFailure),
        recordHandle: deps.recordHandle,
      });
    },
  };
}
