import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readReviewTarget } from "../review/reviewReader.js";
import type { AgentOutputReader } from "./App.js";

/**
 * The data seam behind the `o` agent-output modal: on demand, resolve the
 * selected `live` Issue → its recorded agent handle, read that handle's recent
 * terminal output once via `claude logs <handle>`, and return `{ title, output }`
 * — or `undefined` when the card carries no recorded handle (CONTEXT.md → Agent
 * output, ADR 0023).
 *
 * It is the read sibling of the kill switch ({@link import("../dispatch/kill.js").createKiller}):
 * both resolve a (PRD id, Issue id) to the *same* recorded handle (the agent
 * sidecar, joined via {@link readReviewTarget}) and act on it through one
 * injectable subprocess seam. The kill *stops* the handle; this *reads* it. The
 * read writes nothing, spawns nothing, and changes no status — it is the read-only
 * end of the read/stop duo over one card's recorded handle.
 *
 * The output is the **raw `claude logs` stdout, verbatim**: no markdown render,
 * no client-side truncation, no suppression. In particular Claude's own "No job
 * matching" message — what `claude logs` prints (exit 0) when the agent has just
 * exited between the last scan and the keypress — is returned as-is and shown in
 * the modal, because it is informative and, at exit code 0, indistinguishable from
 * real output anyway. `claude logs` already bounds the volume; the modal's shared
 * `scrollDetail` windows whatever arrives.
 *
 * It returns `undefined` in exactly two cases, both degrading to no modal rather
 * than throwing, mirroring {@link import("./detailReader.js").createDetailReader} /
 * {@link import("../dispatch/kill.js").createKiller}:
 *
 * - **No recorded handle** — a `live` card with no sidecar entry (a verdict/sidecar
 *   race); the App flashes a status-line notice, exactly as Kill does in the same
 *   race.
 * - **Vanished Issue/handle** — the Issue file was deleted between the last scan
 *   and the keypress; the read throws and is swallowed to `undefined`.
 */

/**
 * One `live` agent's recent output resolved for the modal: the Issue's display
 * title and the raw `claude logs` stdout. The output may be empty (the agent has
 * printed nothing yet — the modal shows a placeholder); a *no-handle* card is the
 * seam's `undefined`, not a blank {@link AgentOutput}.
 */
export interface AgentOutput {
  /** Display title: the selected Issue's title, for the modal heading. */
  readonly title: string;
  /** The raw `claude logs <handle>` stdout, rendered as-is in the modal. */
  readonly output: string;
}

/**
 * The single external edge an output read depends on: run `claude logs <handle>`
 * and return its stdout. Injected so {@link createAgentOutputReader} is unit-tested
 * without a real `claude logs` subprocess — one seam per external edge, exactly as
 * the liveness probe and the kill's `claude stop` each have one.
 */
export type LogsSeam = (handle: string) => string;

// The {@link AgentOutputReader} seam the App drives at the Issue level on `o` is
// declared in `ui/App.js` (the App owns the seam contracts it consumes, exactly as
// it does for {@link import("../dispatch/kill.js").Killer}); we import it here so
// there is a single definition and the production builder below can't drift from
// what the App calls.

/**
 * Build the production {@link AgentOutputReader} bound to a watched `root`.
 * `readAgentOutput` resolves the Issue (via the same {@link readReviewTarget} the
 * kill uses) and looks up its recorded handle in the sidecar, keyed by the Issue's
 * **path** — the exact key the spawn edge records under (ADR 0008), the same join
 * `readKill` performs. No recorded handle yields `undefined` (a `live` card always
 * has one, so this only guards the verdict/sidecar race). Otherwise it runs
 * `claude logs` on the frozen handle through the injected {@link LogsSeam} and
 * returns its raw stdout verbatim.
 *
 * Total, like `readKill` / `readDetail`: the root is filesystem-watched and changes
 * under the TUI, so an `o` press can race a deletion — a vanished Issue file yields
 * `undefined` rather than letting an exception escape the Ink input handler.
 */
export function createAgentOutputReader(
  root: string,
  readHandles: () => Record<string, string>,
  logs: LogsSeam,
): AgentOutputReader {
  return {
    readAgentOutput(prdId: string, issueId: string): AgentOutput | undefined {
      const target = readReviewTarget(join(root, prdId), issueId);
      if (!target) return undefined;
      const handle = readHandles()[target.issue.path];
      if (handle === undefined) return undefined;
      return { title: target.issue.title, output: logs(handle) };
    },
  };
}

/**
 * How long to wait for `claude logs` before giving up. It runs synchronously
 * inside the Ink input handler (the `o` press path), so an unbounded call would
 * freeze the board if `claude` hung. On timeout `execFileSync` throws — caught by
 * {@link realLogs} and surfaced as an empty read — never a wedged render loop, the
 * same fail-safe the liveness and kill seams use.
 */
const LOGS_TIMEOUT_MS = 10_000;

/**
 * Cap on captured stdout. `claude logs` already bounds its output to a recent
 * snapshot; the explicit cap just guarantees a runaway `claude` can't be read into
 * an unbounded buffer on the render path. Overflow throws, which {@link realLogs}
 * degrades to an empty read.
 */
const LOGS_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The production {@link LogsSeam}: shell out to `claude logs <handle>` and return
 * its stdout. `claude logs` exits 0 even for a gone handle (printing its "No job
 * matching" message to stdout), so the common path is the clean return. Both stdout
 * and stderr are captured (not inherited) so neither corrupts the Ink alt-screen
 * buffer the TUI is managing.
 *
 * A throw — a non-zero exit, a timeout, a buffer overflow, or `claude` missing from
 * PATH — degrades to a legible error message rather than crashing the read or
 * showing a misleading `(no output yet)` placeholder. Bounded by
 * {@link LOGS_TIMEOUT_MS} and {@link LOGS_MAX_BUFFER} because it runs synchronously
 * on the input path.
 */
export const realLogs: LogsSeam = (handle) => {
  try {
    return execFileSync("claude", ["logs", handle], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOGS_TIMEOUT_MS,
      maxBuffer: LOGS_MAX_BUFFER,
    });
  } catch (err) {
    // Distinguish failure modes so the message is accurate rather than uniformly
    // blaming a missing PATH entry for unrelated errors.
    const code = err instanceof Error && "code" in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ETIMEDOUT") {
      return "(output read timed out — close and press o again to retry)";
    }
    if (code === "ENOBUFS") {
      return "(output too large to display — close and press o again)";
    }
    return "(output unavailable — claude CLI may not be on PATH)";
  }
};
