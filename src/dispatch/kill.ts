import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readReviewTarget } from "../review/reviewReader.js";
import type { DispatchIssue } from "./reader.js";
import type { Killer } from "../ui/App.js";

/**
 * The kill switch: human-triggered termination of a *live* agent Overseer spawned
 * (ADR 0010, CONTEXT.md → Kill). It `claude stop`s the handle the sidecar recorded
 * at spawn (ADR 0008), against the single Issue `K` was pressed on. It is the third
 * of the liveness handle's three layered features — the "true pause of one in-flight
 * agent" the auto-run toggle could not give: `a` stops the Reactor spawning *new*
 * agents, but a running one keeps running until it is killed.
 *
 * It is **stop-only**: it writes nothing to the Issue, so the Issue parks in its
 * active status off the Reactor's frontiers and the stopped agent reads as an
 * orphan on the next scan — recovery is then the *existing* `R` orphan flow
 * (ADR 0009), not a new path. That is what keeps the kill switch small: the
 * recovery half already shipped.
 *
 * Structurally the recovery seam's sibling
 * ({@link import("./rollback.js").createRollback}): both resolve a (PRD id, Issue
 * id) to a frozen preview and act on confirm. The kill differs in that it freezes
 * the *handle* (not just the Issue) and its one external edge is a `claude stop`
 * subprocess ({@link StopSeam}), where the rollback's was a status write.
 */

/**
 * The result of running `claude stop <handle>`: the process exit code and its
 * captured stderr. The {@link classifyStop} mapper needs both — the exit code
 * alone cannot separate "wasn't running" from "couldn't confirm" (ADR 0010).
 *
 * `spawnFailed` marks the distinct case where the child never ran at all (the
 * `claude` binary is missing/not on PATH — an `ENOENT`), as opposed to a `claude`
 * that ran and exited non-zero. A non-zero exit is a transient "try again";
 * a spawn failure is a config error the human must fix, so {@link classifyStop}
 * surfaces it as `unavailable` rather than burying it in `uncertain`.
 */
export interface StopResult {
  readonly exitCode: number;
  readonly stderr: string;
  /** True when `claude` could not be launched at all (e.g. not on PATH). */
  readonly spawnFailed?: boolean;
}

/**
 * The single external edge a kill depends on: run `claude stop <handle>` and
 * report its exit code and stderr. Injected so {@link createKiller} is unit-tested
 * without a real `claude stop` subprocess — one seam per external edge, exactly as
 * the spawn edge and the liveness probe each have one.
 */
export type StopSeam = (handle: string) => StopResult;

/**
 * The verdict the kill surfaces to the human, mapped from `claude stop`'s result
 * (ADR 0010). `claude stop` has three observable outcome shapes, not two:
 *
 * - **stopped** — a clean exit 0.
 * - **not-running** — a non-zero exit whose stderr is the `No job matching '<id>'`
 *   shape: the agent had already finished or died (the stale-`live` case `K` does
 *   not re-query for).
 * - **uncertain** — any other non-zero exit (e.g. `couldn't confirm <id> was
 *   stopped — … Try again`): the stop may be in flight. Collapsing this into
 *   `not-running` would be a false "nothing to stop"; the board's next scan is the
 *   real source of truth, so this only sets honest expectations.
 * - **unavailable** — `claude` could not be launched at all (not installed / not
 *   on PATH). A config error, not a transient hiccup, so it gets its own verdict
 *   the human can act on rather than a misleading "try again" `uncertain`.
 */
export type KillOutcome = "stopped" | "not-running" | "uncertain" | "unavailable";

/** Escape a string for safe interpolation into a `RegExp` (handles are opaque). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map a {@link StopResult} to a {@link KillOutcome}. A clean exit is `stopped`; a
 * non-zero whose stderr carries the `No job matching '<handle>'` shape *for this
 * handle* is `not-running`; every other non-zero is `uncertain` (ADR 0010). The
 * match is on stderr because the exit code is `1` for both the "wasn't running"
 * and the "couldn't confirm" cases — only the message distinguishes them.
 *
 * The match is **anchored to the handle we stopped** (`No job matching '<handle>'`)
 * rather than a bare `No job matching` substring. Anchoring is what makes a false
 * `not-running` hard to reach: a `No job matching '<other-id>'` line bleeding in
 * from a concurrent op, or a reworded message that drops the handle, no longer
 * collapses a genuinely uncertain stop into "nothing to stop" (which would leave a
 * possibly-live agent running while telling the human it was already gone). When in
 * doubt we stay `uncertain` and defer to the board's next scan.
 */
export function classifyStop(result: StopResult, handle: string): KillOutcome {
  if (result.spawnFailed) return "unavailable";
  if (result.exitCode === 0) return "stopped";
  const noJob = new RegExp(`No job matching\\s*'?${escapeRegExp(handle)}`, "i");
  if (noJob.test(result.stderr)) return "not-running";
  return "uncertain";
}

/**
 * The kill preview the App captures on `K` and hands back on confirm. Unlike the
 * orphan's {@link import("./rollback.js").RedispatchPreview}, it freezes the
 * agent **handle** as well as the Issue identity: the kill acts on the handle, not
 * the on-disk status, and ADR 0010 chose to fire the frozen handle on confirm
 * (no re-query) — a stale-`live` stop is a harmless `claude stop` no-op, never the
 * destructive status clobber the rollback re-reads disk to avoid.
 */
export interface KillPreview {
  /** The parent PRD's id, for the modal label. */
  readonly prdId: string;
  /** The Issue's id, for the modal label and the outcome notice. */
  readonly issueId: string;
  /** The live agent's recorded handle, frozen at preview-open — what confirm stops. */
  readonly handle: string;
  /** The live Issue snapshotted at preview-open, for the modal label. */
  readonly issue: DispatchIssue;
}

// The {@link Killer} seam the App drives at the Issue level on `K` is declared in
// `ui/App.js` (the App owns the seam contracts it consumes, exactly as it does for
// {@link import("../ui/App.js").Rollback}); we import it here so there is a single
// definition and the production builder below can't drift from what the App calls.

/**
 * Build the production {@link Killer}. `readKill` resolves the Issue (via the same
 * {@link readReviewTarget} the rollback uses) and looks up its recorded handle in
 * the sidecar, keyed by the Issue's **path** — the exact key the spawn edge
 * records under (ADR 0008). No recorded handle means nothing to stop, so it yields
 * no preview (a `live` card always has one, so this only guards the race where the
 * card's verdict and the sidecar disagree). `kill` fires the frozen handle through
 * the injected {@link StopSeam} and maps the result with {@link classifyStop} —
 * no disk re-read, no re-query (ADR 0010).
 */
export function createKiller(
  root: string,
  readHandles: () => Record<string, string>,
  stop: StopSeam,
): Killer {
  return {
    readKill(prdId: string, issueId: string): KillPreview | undefined {
      const target = readReviewTarget(join(root, prdId), issueId);
      if (!target) return undefined;
      const handle = readHandles()[target.issue.path];
      if (handle === undefined) return undefined;
      return { prdId, issueId, handle, issue: target.issue };
    },

    kill(preview: KillPreview): KillOutcome {
      return classifyStop(stop(preview.handle), preview.handle);
    },
  };
}

/**
 * How long to wait for `claude stop` before giving up. It runs synchronously
 * inside the Ink input handler (the `K` confirm path), so an unbounded call would
 * freeze the board if `claude` hung. On timeout `execFileSync` throws, which
 * {@link realStop} maps to a non-zero {@link StopResult} → `uncertain`, never a
 * wedged render loop — the same fail-safe the spawn and liveness seams use.
 */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Cap on captured output. `claude stop`'s output is a line or two; the cap just
 * guarantees a runaway `claude` can't be read into an unbounded buffer on the
 * render path. Overflow throws, but the thrown error still carries the child's
 * exit code, so a clean (exit-0) stop that merely over-printed is honoured as
 * `stopped` rather than a false `uncertain` (see {@link realStop}).
 */
const STOP_MAX_BUFFER = 1024 * 1024;

/**
 * The production {@link StopSeam}: shell out to `claude stop <handle>` and report
 * its exit code and stderr. `execFileSync` *throws* on a non-zero exit, so the
 * non-zero path is the `catch`: the thrown error carries the child's `status`
 * (exit code), `stderr` (a Buffer), and an error `code` (`ENOENT` when `claude`
 * isn't on PATH), which we surface so {@link classifyStop} can tell `not-running`
 * from `uncertain` from `unavailable`. A clean exit returns `{ exitCode: 0 }`.
 * stdout is captured (not inherited) so `claude stop`'s success chatter does not
 * corrupt the alt-screen board; stderr is captured for the classify.
 */
export const realStop: StopSeam = (handle) => {
  try {
    execFileSync("claude", ["stop", handle], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: STOP_MAX_BUFFER,
    });
    return { exitCode: 0, stderr: "" };
  } catch (err) {
    // A non-zero exit (or a timeout / buffer overflow / spawn failure) throws here.
    // Pull the child's exit code, stderr, and error `code` off the error.
    const e = err as {
      status?: number;
      stderr?: Buffer | string;
      code?: string;
    };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";

    // `ENOENT` means `claude` itself could not be launched (missing / not on
    // PATH) — a config error, not a non-zero exit. Flag it so classifyStop reads
    // `unavailable` and the human is told the real cause, not a transient retry.
    if (e.code === "ENOENT") {
      return { exitCode: 1, stderr, spawnFailed: true };
    }

    // `maxBuffer` overflow throws even when the child exited cleanly — the stop
    // still landed, only the captured chatter was too big. Honour the real exit
    // code when the error carries one, so an exit-0-but-noisy stop is not a false
    // `uncertain`. Default to a non-zero code so an error with no status still
    // reads as a failure, never a false `stopped`.
    const exitCode = typeof e.status === "number" ? e.status : 1;
    return { exitCode, stderr };
  }
};
