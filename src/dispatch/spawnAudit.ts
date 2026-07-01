import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { errorMessage } from "../errorMessage.js";

/**
 * A diagnostic trail of every `claude --bg` launch Overseer makes, appended at the
 * single shared `spawn` seam (so the Reactor's auto-spawns and the manual
 * `d`/`c`/`r` cranks all land here). It exists to make an over-spawn *catchable*:
 * if the same edge relaunches the same Issue seconds apart — the double-spawn a
 * stale read→flip→spawn window would produce — the two lines are hard evidence,
 * where the board alone only shows a hunch. Purely observational: it changes no
 * spawn behaviour and never throws (a diagnostic aid must not crash the board).
 *
 * Kept beside the durable failure log and the sidecar under `~/.local/state`
 * (never the watched root, ADR 0002), and deliberately *not* wired through the
 * edge deps: it reads everything it needs off the two values the seam already has
 * — the target `repo` and the built prompt (which names the edge and the Issue).
 */

/** `~/.local/state/overseer/spawn-audit.log`, beside the failure log and sidecar. */
export function defaultSpawnAuditPath(): string {
  return join(homedir(), ".local", "state", "overseer", "spawn-audit.log");
}

/** Opening line of every agent prompt: `…autonomous <role> agent dispatched…`. */
const EDGE = /autonomous (\w+) agent dispatched by Overseer/;
/** The Issue file each prompt names as the one to edit — its absolute path. */
const ISSUE_PATH = /Issue file to edit is:[\s\S]*?(\/\S+\.md)/;

/**
 * Best-effort identification of a spawn from its built prompt: which edge it is
 * (implementor / auditor / reviewer, from the opening line) and the absolute path
 * of the Issue it targets (the `…file to edit is: <path>` the prompt embeds). Both
 * fall back to `"unknown"` if a prompt shape ever drifts, so the log line is always
 * well-formed. Pure, so it is unit-testable without touching the filesystem.
 */
export function describeSpawn(prompt: string): {
  readonly edge: string;
  readonly issuePath: string;
} {
  return {
    edge: EDGE.exec(prompt)?.[1] ?? "unknown",
    issuePath: ISSUE_PATH.exec(prompt)?.[1] ?? "unknown",
  };
}

/** One launch to record: where it ran, its prompt, and the outcome. */
export interface SpawnAuditRecord {
  readonly repo: string;
  readonly prompt: string;
  /** The handle the launch returned, or `undefined` (no handle / the launch threw). */
  readonly handle: string | undefined;
  /** Set only when the launch threw — the error message, so a failed relaunch is visible. */
  readonly error?: unknown;
}

/**
 * Append one tab-separated spawn-audit line: timestamp, the launching process pid
 * (so a stray second board instance is distinguishable), the edge, the Issue path,
 * the repo, and the outcome (handle or error). Never throws — a diagnostic write
 * that fails must not escape the spawn seam and crash the board.
 */
export function appendSpawnAudit(path: string, record: SpawnAuditRecord): void {
  try {
    const { edge, issuePath } = describeSpawn(record.prompt);
    const outcome =
      record.error !== undefined
        ? `error=${errorMessage(record.error)}`
        : `handle=${record.handle ?? "(none)"}`;
    const line =
      [
        new Date().toISOString(),
        `pid=${process.pid}`,
        edge,
        issuePath,
        `repo=${record.repo}`,
        outcome,
      ].join("\t") + "\n";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
  } catch {
    // The audit log is unwritable (e.g. an unusable state dir). Losing a
    // diagnostic line must never crash the board or block the spawn it describes.
  }
}
