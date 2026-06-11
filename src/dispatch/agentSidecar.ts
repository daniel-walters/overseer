import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The agent sidecar: Overseer's durable map of `issueKey → handle`, persisted as
 * JSON outside the watched root (`~/.local/state/overseer/agents.json`, beside
 * the dispatch failure log — ADR 0008). The handle is the `claude --bg` launch
 * handle captured at spawn time; persisting it here — never in the Issue files —
 * is what lets a later board open join a live `claude agents --json` row back to
 * its Issue while keeping the viewer read-only (ADR 0002) and resume free.
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
   * Record `issueKey → handle`, overwriting any prior handle for that Issue. A
   * re-dispatch (the Issue spawned again in a later session) replaces the stale
   * handle rather than accumulating duplicates.
   */
  record(issueKey: string, handle: string): void;
  /**
   * Read the full `issueKey → handle` map. A missing sidecar file (no spawn has
   * recorded yet, or a fresh machine) — or a corrupt one (truncated, hand-edited,
   * or a non-object JSON value) — reads as an empty map, never an error, so the
   * liveness join is total on first board open and `record` self-heals by
   * overwriting a bad file.
   */
  read(): Record<string, string>;
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
  const read = (): Record<string, string> => {
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
      // Keep only `string → string` entries. A hand-edited or partially-corrupt
      // file can hold a non-string value (`{"prd/001.md": 42}`); dropping it
      // rather than casting it through keeps the liveness join total — a
      // non-string handle could never match a live session `id` anyway, the same
      // "a row with no usable string id is dropped" rule parseAgents applies.
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") map[key] = value;
      }
      return map;
    } catch {
      return {};
    }
  };

  return {
    read,

    record(issueKey: string, handle: string): void {
      const map = read();
      map[issueKey] = handle;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(map, null, 2));
    },
  };
}
