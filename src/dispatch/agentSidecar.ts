import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * One Issue's row in the sidecar: the `claude --bg` launch {@link handle} captured
 * at spawn time, and an optional {@link reviewPass} — the AI-review pass number the
 * Reactor is driving for this Issue, recorded by Overseer per spawn (ADR 0018), the
 * single source of truth for both the loop's cap check and the in-review card's
 * `N/cap` marker (the Reviewer Iteration Count PRD).
 *
 * `reviewPass` is **absent** for any Issue not in an AI-review pass — a dispatched
 * (`in-progress`) agent, or a legacy entry written before the sidecar carried a
 * pass. Absent reads as "no count" (no marker), deliberately distinct from a
 * recorded `0`: the count must never render a false marker from a default.
 */
export interface AgentEntry {
  /** The `claude --bg` launch handle, the same string a live session reports as its `id`. */
  readonly handle: string;
  /**
   * The currently-running AI-review pass for this Issue, `undefined` when none is
   * recorded. A 1-based count Overseer increments per review spawn; the marker
   * renders it as `reviewPass/cap`. Absent ≠ `0`.
   */
  readonly reviewPass?: number;
}

/**
 * The agent sidecar: Overseer's durable map of `issueKey → entry`, persisted as
 * JSON outside the watched root (`~/.local/state/overseer/agents.json`, beside
 * the dispatch failure log — ADR 0008). Each entry carries the `claude --bg`
 * launch handle captured at spawn time, plus an optional AI-review pass number
 * (ADR 0018); persisting both here — never in the Issue files — is what lets a
 * later board open join a live `claude agents --json` row back to its Issue and
 * recover the in-flight pass number, while keeping the viewer read-only (ADR 0002)
 * and resume free.
 *
 * It is the operational-state sibling of the session-scoped failed-set
 * ({@link import("../reactor/failedSet.js").FailedSet}): same "Overseer's own
 * state, not domain data" role, but *durable* (it must survive a board restart so
 * a previous session's spawn can still be joined), so it is file-backed rather
 * than an in-memory Set.
 *
 * The `issueKey` is opaque to the sidecar — the caller chooses it (the dispatch
 * edge uses the Issue's full path `prdDir/filename`, unique across PRDs, exactly
 * as the failed-set does).
 */
export interface AgentSidecar {
  /**
   * Record `issueKey → { handle, reviewPass }`, overwriting any prior entry for
   * that Issue. A re-dispatch (the Issue spawned again in a later session) replaces
   * the stale entry rather than accumulating duplicates. `reviewPass` is recorded
   * only when given — a dispatch spawn passes none (the entry reads as no count),
   * while a review spawn passes the pass it is driving (ADR 0018). Overseer is the
   * only writer of the count; no agent ever calls this with a pass.
   */
  record(issueKey: string, handle: string, reviewPass?: number): void;
  /**
   * Read the full `issueKey → entry` map. A missing sidecar file (no spawn has
   * recorded yet, or a fresh machine) — or a corrupt one (truncated, hand-edited,
   * or a non-object JSON value) — reads as an empty map, never an error, so the
   * liveness join is total on first board open and `record` self-heals by
   * overwriting a bad file. Every surviving entry is normalised to an
   * {@link AgentEntry}: a legacy bare-`string` value (written before the sidecar
   * carried a pass) reads as `{ handle }` with no pass, and a malformed entry
   * (non-object, missing/non-string handle, non-number pass) is dropped or coerced
   * so the result is always total over bad input.
   */
  read(): Record<string, AgentEntry>;
}

/**
 * The default sidecar location: `~/.local/state/overseer/agents.json`, beside the
 * dispatch failure log ({@link import("./spawn.js").defaultLogPath}). Kept under
 * `~/.local/state` (the XDG state dir) so Overseer's operational state never
 * lands in the user's watched domain files.
 */
export function defaultSidecarPath(): string {
  return join(homedir(), ".local", "state", "overseer", "agents.json");
}

/**
 * Build a file-backed {@link AgentSidecar} at `path`. Read and record are each a
 * single whole-file operation: the map is small (one entry per in-flight agent)
 * and only ever touched on a spawn (write) or a board open (read), so there is no
 * need for anything more than read-modify-write of one JSON object.
 */
export function createAgentSidecar(path: string): AgentSidecar {
  // A free function, not a method, so the returned object can be safely
  // destructured by callers (`const { record } = createAgentSidecar(...)`)
  // without `record` losing its `this` reference to `read`.
  const read = (): Record<string, AgentEntry> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      // No sidecar yet (nothing spawned, or a fresh machine). An empty map
      // keeps the liveness join total on first open.
      return {};
    }
    // A corrupt sidecar — truncated by a crash mid-write, hand-edited, or holding
    // a non-object JSON value — reads as an empty map, exactly like a missing one,
    // so `read` is total and `record` self-heals by overwriting the bad file. The
    // alternative (letting `JSON.parse` throw) would permanently wedge `record`:
    // its caller swallows the throw, so every later spawn would silently no-op
    // against the same unparseable file.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      // Normalise each value to an AgentEntry, dropping anything with no usable
      // string handle. The reader is total over every legacy/bad shape:
      //   - a bare `string` is a legacy entry (written before the pass existed) —
      //     it reads as `{ handle }`, no pass, never an error;
      //   - an object reads its `handle` (must be a string, else the whole entry
      //     is dropped — a non-string handle could never join a live session `id`,
      //     the same rule parseLiveSet applies) and an *optional* `reviewPass`,
      //     kept only when it is a real number (a missing/`NaN`/non-number pass is
      //     simply absent — distinct from a recorded `0`, so no false marker);
      //   - any other value (number, array, null) is dropped.
      const map: Record<string, AgentEntry> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const entry = normaliseEntry(value);
        if (entry !== undefined) map[key] = entry;
      }
      return map;
    } catch {
      return {};
    }
  };

  return {
    read,

    record(issueKey: string, handle: string, reviewPass?: number): void {
      const map = read();
      map[issueKey] =
        reviewPass === undefined ? { handle } : { handle, reviewPass };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(map, null, 2));
    },
  };
}

/**
 * Coerce one raw sidecar value into an {@link AgentEntry}, or `undefined` if it
 * carries no usable handle (so the caller drops it). This is the totality seam:
 * every bad or legacy shape that could be on disk lands here and degrades
 * gracefully rather than throwing or rendering a false count.
 *
 * - A bare `string` is a **legacy** entry from before the pass existed — `{ handle }`.
 * - An object yields `{ handle }` (plus `reviewPass` when it is a real `number`);
 *   a missing or non-number `reviewPass` is left absent, never defaulted to `0`,
 *   and a `NaN` is rejected too (an absent count must stay distinguishable).
 * - Anything else (number, array, null, an object with a non-string handle) → `undefined`.
 */
function normaliseEntry(value: unknown): AgentEntry | undefined {
  if (typeof value === "string") return { handle: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.handle !== "string") return undefined;
  if (typeof record.reviewPass === "number" && !Number.isNaN(record.reviewPass)) {
    return { handle: record.handle, reviewPass: record.reviewPass };
  }
  return { handle: record.handle };
}
