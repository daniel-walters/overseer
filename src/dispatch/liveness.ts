import { execFileSync } from "node:child_process";
import type { Liveness } from "../model.js";

/**
 * Liveness: the query+join that makes an `in-progress` / `in-review` Issue
 * *truthful* about whether the agent Overseer spawned for it is still running
 * (ADR 0008, CONTEXT.md). It reads Claude's session registry
 * (`claude agents --json`), intersects the live session `id`s against the
 * handles Overseer recorded at spawn time (the {@link import("./agentSidecar.js").AgentSidecar}),
 * and returns a per-Issue verdict: **live** if the Issue's recorded handle is in
 * the live set, **unknown** otherwise.
 *
 * It is a derived overlay, recomputed on each board open — never persisted into
 * the Issue files (ADR 0002). The whole module is pure data-in/data-out behind
 * one seam (the registry query), so it is unit-tested with fixture JSON and no
 * real Claude process, exactly as the dispatcher is.
 *
 * The {@link Liveness} verdict type lives on the board model (it is a card
 * overlay); this module produces it.
 */

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

/**
 * Parse `claude agents --json` stdout into the live sessions. The registry
 * prints a JSON array of session rows, each with an `id` and a state field whose
 * *name* differs by row shape — interactive rows use `status`, background rows
 * use `state` (ADR 0008). Both are normalised to {@link LiveAgent.state} so the
 * join never branches on shape.
 *
 * Total over bad input: malformed JSON, a non-array value, or an empty array all
 * read as "no live agents", so a registry that printed garbage degrades every
 * Issue to unknown rather than crashing the board open — the same fail-safe the
 * sidecar uses for a corrupt file. A row with no usable string `id` is dropped
 * (it can join no Issue); the state field's absence is kept as `undefined`.
 */
export function parseAgents(json: string): LiveAgent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const agents: LiveAgent[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") continue;
    // Interactive rows carry `status`; background rows carry `state`. Prefer
    // `state`, fall back to `status`, and keep `undefined` if neither is a string.
    const stateField = record.state ?? record.status;
    const state = typeof stateField === "string" ? stateField : undefined;
    agents.push({ id, state });
  }
  return agents;
}

/**
 * Join the recorded `issueKey → handle` map against the live agents into a
 * per-Issue verdict. An Issue is **live** iff its recorded handle is present as a
 * live session `id`; otherwise **unknown**. Only Issues that were ever recorded
 * appear in the result — an Issue with no recorded handle has no verdict to give
 * (it reads as no marker on the card), distinct from one whose handle is gone.
 *
 * This is the membership test at the heart of liveness (ADR 0008): pure, with no
 * I/O, so it is exhaustively testable with fixture handles and a fixture live set.
 */
export function computeLiveness(
  recordedHandles: Record<string, string>,
  liveAgents: readonly LiveAgent[],
): Record<string, Liveness> {
  const liveIds = new Set(liveAgents.map((a) => a.id));
  const verdicts: Record<string, Liveness> = {};
  for (const [issueKey, handle] of Object.entries(recordedHandles)) {
    verdicts[issueKey] = liveIds.has(handle) ? "live" : "unknown";
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
 * Build the liveness probe: a `() => Record<issueKey, Liveness>` that, on each
 * call, re-queries the registry, parses it, reads the recorded handles, and
 * re-intersects. Calling it on every board rebuild is what keeps liveness a
 * derived overlay and never a stale cache (ADR 0002 / 0008) — a handle that
 * dropped out of the registry flips live → unknown on the next call.
 *
 * Total: if the registry query throws (the `claude` binary is missing, or it
 * exits non-zero), the probe treats it as "no live agents", so every recorded
 * Issue reads as unknown — never a false live, never a crashed board open.
 */
export function createLivenessProbe(
  deps: LivenessProbeDeps,
): () => Record<string, Liveness> {
  return () => {
    let json: string;
    try {
      json = deps.query();
    } catch {
      // The registry is unreachable; degrade every recorded Issue to unknown
      // rather than crashing the board open.
      json = "[]";
    }
    return computeLiveness(deps.readHandles(), parseAgents(json));
  };
}

/**
 * The production registry-query seam: shell out to `claude agents --json` and
 * return its stdout. `encoding: "utf8"` makes `execFileSync` return a string;
 * stderr is inherited so any diagnostic still reaches the terminal.
 */
export const realLivenessQuery: LivenessSeam = () =>
  execFileSync("claude", ["agents", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
