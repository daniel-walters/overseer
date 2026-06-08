import { join } from "node:path";
import { computeFrontier, type FrontierEntry } from "./frontier.js";
import { readDispatchView } from "./reader.js";
import { writeStatus } from "./statusWriter.js";
import { runDispatch } from "./dispatch.js";
import type { DispatchIssue } from "./reader.js";
import type { Dispatcher } from "../ui/App.js";

/**
 * Build the production {@link Dispatcher} the App drives: it resolves a PRD id
 * to its directory under `root`, reads + classifies its frontier for the
 * preview, and on confirm flips each spawn candidate to `in-progress` (via the
 * status-writer) before calling `spawn`.
 *
 * `spawn` is injected — this tracer-bullet slice passes a stub, so the whole
 * keypress → status-flip → live-board path is proven before the real spawn tip
 * (validate repo, ensure branch, `claude --bg`) exists.
 */
export function createDispatcher(
  root: string,
  spawn: (issue: DispatchIssue) => void,
): Dispatcher {
  return {
    readFrontier(prdId: string): readonly FrontierEntry[] {
      return computeFrontier(readDispatchView(join(root, prdId)));
    },
    dispatch(frontier: readonly FrontierEntry[]): void {
      runDispatch(frontier, { writeStatus, spawn });
    },
  };
}
