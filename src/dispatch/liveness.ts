import { execFileSync } from "node:child_process";

/**
 * Liveness: the query+join that makes an `in-progress` / `in-review` Issue
 * *truthful* about whether the agent Overseer spawned for it is still running
 * (ADR 0008 / 0009, CONTEXT.md). It reads Claude's session registry
 * (`claude agents --json`), intersects the live session `id`s against the
 * handles Overseer recorded at spawn time (the {@link import("./agentSidecar.js").AgentSidecar}),
 * and returns a per-Issue **trust-qualified absence** ({@link Absence}): `live`
 * if the recorded handle is in the live set, `absent-clean` if it is gone after a
 * trustworthy query, `absent-degraded` if it is gone but the query could not be
 * trusted.
 *
 * The probe stays *status-ignorant*: it knows nothing about lanes. The scanner —
 * the one place that knows which cards an active agent owns — maps `absent-clean`
 * on an active card to `orphaned` and everything else to `unknown` (ADR 0009).
 * Keeping the gate there keeps this join a pure handle-membership test.
 *
 * It is a derived overlay, recomputed on each board open — never persisted into
 * the Issue files (ADR 0002). The whole module is pure data-in/data-out behind
 * one seam (the registry query), so it is unit-tested with fixture JSON and no
 * real Claude process, exactly as the dispatcher is.
 */

/**
 * The probe's per-Issue verdict: a trust-qualified absence (ADR 0009).
 *
 * - **live** — the recorded handle is a live session `id`.
 * - **absent-clean** — the handle is gone *and* the query was trustworthy (a
 *   cleanly-parsed array, even an empty one: Claude is up and reports this agent
 *   is not among the live). Only this licenses an `orphaned` card.
 * - **absent-degraded** — the handle is gone but the query could not be trusted
 *   (it threw, or its output did not parse to an array). The agent might still be
 *   alive behind a hiccup, so this can only ever read as `unknown` — a false
 *   `orphaned` invites a re-dispatch that double-spawns a live agent (ADR 0009).
 */
export type Absence = "live" | "absent-clean" | "absent-degraded";

/**
 * One live session from `claude agents --json`, normalised across the two row
 * shapes. The join only needs {@link id}; {@link state} is captured for a future
 * "is it hung?" iteration (ADR 0008) but no behaviour is built on it here.
 */
export interface LiveAgent {
  /** The session id — the same string `claude --bg` prints as its launch handle. */
  readonly id: string;
  /**
   * The session's busy/blocked/idle state, read from whichever field the row
   * carries (interactive rows use `status`, background rows use `state`).
   * `undefined` when neither field is present. Captured, not yet acted on.
   */
  readonly state: string | undefined;
}

/** The first argument that is a non-empty string, or `undefined` if none is. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * The result of parsing a registry query: the live agents *and* whether the
 * query was trustworthy (ADR 0009). `degraded` is true when the output did not
 * parse to a JSON array (malformed JSON, or a non-array value like an error
 * object) — Claude can't be trusted to have reported the true live set, so no
 * absent handle may be called `orphaned`. A cleanly-parsed array, even an empty
 * one, is trustworthy: `degraded` is false and an absent handle is genuinely
 * gone.
 */
export interface ParsedAgents {
  readonly agents: LiveAgent[];
  readonly degraded: boolean;
}

/**
 * Parse `claude agents --json` stdout into the live sessions, distinguishing a
 * trustworthy result from a degraded one (ADR 0009). The registry prints a JSON
 * array of session rows, each with an `id` and a state field whose *name* differs
 * by row shape — interactive rows use `status`, background rows use `state` (ADR
 * 0008). Both are normalised to {@link LiveAgent.state} so the join never branches
 * on shape; a row with no usable string `id` is dropped (it can join no Issue).
 *
 * Only a value that parses to an array yields `degraded: false` — even an empty
 * array, which is a *trustworthy* "no live agents" (Claude is up and reports
 * none). Anything else (unparseable JSON, or a non-array value like an error
 * object) yields an empty live set flagged `degraded: true`, so the probe can
 * keep those absent handles at `unknown` rather than flagging them `orphaned`.
 * Either way it is total over bad input — the board never crashes on garbage.
 *
 * **Known limit (a clean empty array is trusted, even transiently).** A
 * single `[]` licenses `absent-clean` for *every* recorded active handle at once,
 * so one momentary empty result — a registry that restarted and briefly reports
 * zero sessions while agents reconnect — flags every active card `orphaned` in
 * one scan. ADR 0009 accepts this: an empty array is a positive "Claude is up,
 * no live agents", and the human (never the reactor) is the safety check before
 * any re-dispatch. The recovery is also non-destructive and re-checked at confirm
 * (the rollback re-reads disk), so a transient false `orphaned` self-clears on
 * the next scan with no action taken. Debouncing N consecutive empties was
 * rejected as it would reintroduce the stale cache ADR 0002 / 0008 forbid.
 */
export function parseLiveSet(json: string): ParsedAgents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { agents: [], degraded: true };
  }
  if (!Array.isArray(parsed)) return { agents: [], degraded: true };

  const agents: LiveAgent[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") continue;
    // Interactive rows carry `status`; background rows carry `state`. Prefer the
    // first that is a non-empty string, and keep `undefined` if neither is. (A
    // bare `??` would let an empty-string `state: ""` win over a meaningful
    // `status`, since `??` only short-circuits on null/undefined.)
    const state = firstString(record.state, record.status);
    agents.push({ id, state });
  }
  return { agents, degraded: false };
}

/**
 * Join the recorded `issueKey → handle` map against the live agents into a
 * per-Issue {@link Absence} verdict. An Issue is **live** iff its recorded handle
 * is present as a live session `id`. Otherwise it is absent — `absent-degraded`
 * when the query that produced this live set could not be trusted (`degraded`),
 * `absent-clean` when it could. Only Issues that were ever recorded appear in the
 * result — an Issue with no recorded handle has no verdict to give (it reads as
 * no marker on the card), distinct from one whose handle is gone.
 *
 * The join never branches on lane or status; it only knows membership and trust.
 * Mapping `absent-clean` to `orphaned` is the scanner's job (ADR 0009). Pure,
 * with no I/O, so it is exhaustively testable with fixture handles and a fixture
 * live set.
 *
 * **Known limit (membership is id-only).** A handle counts as `live` purely by
 * its `id` being *present* in the registry — the row's {@link LiveAgent.state} is
 * captured but deliberately not consulted here. So an agent that has exited but
 * whose row still lingers in `claude agents --json` (a retention window) reads
 * `live`, not `orphaned`, until the row ages out. Reading `state` to call a
 * lingering row dead is the "is it hung?" iteration ADR 0009 defers (a wrong
 * guess at which state strings mean *terminated* would turn live agents into
 * false orphans — the worse failure), so membership stays id-only on purpose.
 */
export function computeLiveness(
  recordedHandles: Record<string, string>,
  liveAgents: readonly LiveAgent[],
  degraded: boolean,
): Record<string, Absence> {
  const liveIds = new Set(liveAgents.map((a) => a.id));
  const absent: Absence = degraded ? "absent-degraded" : "absent-clean";
  const verdicts: Record<string, Absence> = {};
  for (const [issueKey, handle] of Object.entries(recordedHandles)) {
    verdicts[issueKey] = liveIds.has(handle) ? "live" : absent;
  }
  return verdicts;
}

/** The registry-query seam: run `claude agents --json` and return its stdout. */
export type LivenessSeam = () => string;

/** The seams a {@link createLivenessProbe} depends on, injected for testing. */
export interface LivenessProbeDeps {
  /** Run `claude agents --json` (the default seam shells out via `execFileSync`). */
  readonly query: LivenessSeam;
  /** Read the recorded `issueKey → handle` map (the agent sidecar's `read`). */
  readonly readHandles: () => Record<string, string>;
}

/**
 * Build the liveness probe: a `() => Record<issueKey, Absence>` that, on each
 * call, re-queries the registry, parses it (capturing whether the result was
 * trustworthy), reads the recorded handles, and re-intersects. Calling it on
 * every board rebuild is what keeps liveness a derived overlay and never a stale
 * cache (ADR 0002 / 0008) — a handle that dropped out of the registry flips
 * `live → absent-*` on the next call.
 *
 * The probe never crashes the board open on a bad query. But — unlike ADR 0008's
 * blanket "degrade to all-unknown on any trouble" — it now distinguishes *why* a
 * handle is absent (ADR 0009). A query that **throws** (the `claude` binary is
 * missing, a non-zero exit, a timeout) or whose output **does not parse to an
 * array** is degraded: every absent handle reads `absent-degraded`, which the
 * scanner keeps at `unknown`, never `orphaned`. Only a cleanly-parsed array
 * licenses `absent-clean`. A false `orphaned` is worse than a false `unknown`: it
 * invites a re-dispatch that could double-spawn a still-live agent.
 */
export function createLivenessProbe(
  deps: LivenessProbeDeps,
): () => Record<string, Absence> {
  return () => {
    let parsed: ParsedAgents;
    try {
      parsed = parseLiveSet(deps.query());
    } catch {
      // The query itself threw (binary missing, non-zero exit, timeout): the
      // registry is unreachable, so the result is degraded — every absent handle
      // stays `unknown`, never `orphaned`, and the board still opens.
      parsed = { agents: [], degraded: true };
    }
    return computeLiveness(deps.readHandles(), parsed.agents, parsed.degraded);
  };
}

/**
 * How long to wait for `claude agents --json` before giving up. The probe runs
 * synchronously on the board's startup path and inside the debounced watcher
 * callback (one query per rebuild), so an unbounded query would freeze the whole
 * Ink render loop if `claude` hung or was slow. On timeout `execFileSync` throws,
 * which {@link createLivenessProbe} catches and degrades to all-unknown — so the
 * cap fails safe: a slow registry costs at most this delay, never a frozen board.
 */
const QUERY_TIMEOUT_MS = 3000;

/**
 * Cap on captured stdout. `claude agents --json` is small (one row per live
 * session), so the 1 MiB default would never be hit in practice; the explicit
 * cap just guarantees a runaway registry can't be read into an unbounded buffer
 * on the render path. Overflow throws, which the probe degrades to all-unknown.
 */
const QUERY_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The production registry-query seam: shell out to `claude agents --json` and
 * return its stdout. `encoding: "utf8"` makes `execFileSync` return a string;
 * stderr is inherited so any diagnostic still reaches the terminal. Bounded by
 * {@link QUERY_TIMEOUT_MS} and {@link QUERY_MAX_BUFFER} because this runs
 * synchronously on the board's hot path; either bound being hit throws, and the
 * probe degrades that to unknown rather than hanging or crashing the board.
 */
export const realLivenessQuery: LivenessSeam = () =>
  execFileSync("claude", ["agents", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: QUERY_TIMEOUT_MS,
    maxBuffer: QUERY_MAX_BUFFER,
  });
