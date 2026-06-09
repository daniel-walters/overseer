import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FailureRecord } from "./dispatch.js";

/**
 * The real spawn tip of the dispatch edge: launch one implementor agent and
 * append spawn failures to a durable log. The orchestration (validate, ensure
 * branch, flip, rollback) lives in {@link import("./dispatch.js").runDispatch};
 * this module owns only the two true I/O actions — shelling out to `claude` and
 * writing the log — behind an injectable exec seam so the dispatcher is tested
 * without launching real Claude.
 */

/** Run a command, waiting for it to launch; throws on non-zero exit. */
export type ExecSeam = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => void;

/** The spawn-edge seams: the child-process exec and the failure-log location. */
export interface SpawnEdgeDeps {
  /** Runs `claude` (the default seam shells out via `execFileSync`). */
  readonly exec: ExecSeam;
  /** Absolute path to the durable failure log. */
  readonly logPath: string;
}

/** The spawn-edge functions {@link runDispatch} consumes. */
export interface SpawnEdge {
  /** Launch an implementor in `repo` with `prompt`. Throws if the launch fails. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a timestamped failure record to the durable log. */
  readonly logFailure: (record: FailureRecord) => void;
}

/**
 * The durable spawn-failure log, outside the watched root and the target repos:
 * `~/.local/state/overseer/dispatch.log`.
 */
export function defaultLogPath(): string {
  return join(homedir(), ".local", "state", "overseer", "dispatch.log");
}

/**
 * Build the spawn edge from its seams. `spawn` runs
 * `claude --bg --permission-mode auto -p <prompt>` with `cwd = repo`, so the
 * agent works autonomously in the background in its target repo. A launch
 * failure propagates to the caller (which rolls the Issue back and logs).
 */
export function createSpawnEdge(deps: SpawnEdgeDeps): SpawnEdge {
  return {
    spawn(repo: string, prompt: string): void {
      deps.exec(
        "claude",
        ["--bg", "--permission-mode", "auto", "-p", prompt],
        { cwd: repo },
      );
    },

    logFailure(record: FailureRecord): void {
      mkdirSync(dirname(deps.logPath), { recursive: true });
      const line = `${new Date().toISOString()}\t${record.edge}\t${record.issueId}\t${record.repo}\t${record.error}\n`;
      appendFileSync(deps.logPath, line);
    },
  };
}

/** The production exec seam: shell out to `claude` and wait for the launch. */
export const realExec: ExecSeam = (command, args, options) => {
  execFileSync(command, [...args], { cwd: options.cwd, stdio: "ignore" });
};
