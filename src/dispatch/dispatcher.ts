import { basename, join } from "node:path";
import { computeFrontier, type FrontierEntry } from "./frontier.js";
import { readDispatchView, type DispatchView } from "./reader.js";
import { writeStatus } from "./statusWriter.js";
import { runDispatch, type FailureRecord } from "./dispatch.js";
import { featureBranchName, type GitSeam } from "./gitSetup.js";
import { buildImplementorPrompt } from "./implementorPrompt.js";
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
  /** Launch an implementor in `repo` with `prompt`; throws if the launch fails. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
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
        logFailure: deps.logFailure,
      });
    },
  };
}
