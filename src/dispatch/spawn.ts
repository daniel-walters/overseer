import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FailureRecord } from "./dispatch.js";
import { parseHandle } from "./handle.js";
import { agentFlags, type AgentConfig } from "../agentConfig.js";

/**
 * The real spawn tip of the dispatch edge: launch one implementor agent and
 * append spawn failures to a durable log. The orchestration (validate, ensure
 * branch, flip, rollback) lives in {@link import("./dispatch.js").runDispatch};
 * this module owns only the two true I/O actions — shelling out to `claude` and
 * writing the log — behind an injectable exec seam so the dispatcher is tested
 * without launching real Claude.
 */

/**
 * Run a command, waiting for it to launch, and return its stdout; throws on
 * non-zero exit. Returns stdout (rather than the old `=> void`) so the spawn edge
 * can parse the `backgrounded · <handle>` line `claude --bg` prints — the seam
 * where "launch and forget" becomes "launch and remember" (ADR 0008).
 */
export type ExecSeam = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => string;

/** The spawn-edge seams: the child-process exec and the failure-log location. */
export interface SpawnEdgeDeps {
  /** Runs `claude` (the default seam shells out via `execFileSync`). */
  readonly exec: ExecSeam;
  /** Absolute path to the durable failure log. */
  readonly logPath: string;
}

/** The spawn-edge functions {@link runDispatch} consumes. */
export interface SpawnEdge {
  /**
   * Launch an agent in `repo` with `prompt`, returning the agent handle parsed
   * from `claude --bg`'s launch stdout (or `undefined` if the launch line carried
   * none). Throws if the launch itself fails. The optional {@link AgentConfig}
   * adds `--model` / `--effort` before the positional prompt — both edges call this one seam,
   * each supplying its own runtime (implementor vs reviewer), so model/effort can
   * differ per edge from a single shared spawn. Omitted ⇒ inherit the launcher's
   * model and effort (the pre-knob behaviour).
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
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
 * `claude --bg --permission-mode auto [--model M] [--effort E] <prompt>` with
 * the prompt as the positional argument — the current `claude` CLI rejects
 * `--bg` combined with `-p`/`--print` (a `--print` job never starts the
 * interactive session `claude agents` attaches to, so it would be unattachable),
 * and `--bg` is itself the headless launch. `cwd = repo`, so the agent works
 * autonomously in the background in its target
 * repo, and returns the handle parsed from the launch stdout so the caller can
 * record it against the Issue (ADR 0008). The `--model`/`--effort` flags are
 * present only when the caller passes an {@link AgentConfig} with those knobs set
 * (see {@link agentFlags}); the implementor and reviewer edges pass their own, so
 * one shared spawn launches each edge's agent at its configured model and effort.
 * A launch failure propagates to the caller (which rolls the Issue back and logs).
 */
export function createSpawnEdge(deps: SpawnEdgeDeps): SpawnEdge {
  return {
    spawn(repo: string, prompt: string, agent?: AgentConfig): string | undefined {
      const stdout = deps.exec(
        "claude",
        [
          "--bg",
          "--permission-mode",
          "auto",
          ...agentFlags(agent),
          prompt,
        ],
        { cwd: repo },
      );
      return parseHandle(stdout);
    },

    logFailure(record: FailureRecord): void {
      mkdirSync(dirname(deps.logPath), { recursive: true });
      const line = `${new Date().toISOString()}\t${record.edge}\t${record.issueId}\t${record.repo}\t${record.error}\n`;
      appendFileSync(deps.logPath, line);
    },
  };
}

/**
 * How long to wait for the `claude --bg` launch line before giving up. The spawn
 * runs synchronously inside the Ink input handler (the `d`/`r` confirm path and
 * the Reactor both flow through here), so an unbounded capture would freeze the
 * whole board if the launch hung. It must hang at most this long: a `--bg` child
 * that inherits/keeps the captured stdout fd open after the parent backgrounds
 * would otherwise hold the pipe past EOF forever — exactly the freeze the
 * liveness query is bounded against ({@link import("./liveness.js")}). On timeout
 * `execFileSync` throws, which the spawn edge surfaces as a launch failure
 * (rollback + log), never a wedged render loop.
 */
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Cap on captured launch stdout. The handle line is a few dozen bytes; the cap
 * just guarantees a runaway `claude` can't be read into an unbounded buffer on
 * the render path. Overflow throws, surfaced as a launch failure.
 */
const LAUNCH_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The production exec seam: shell out to `claude`, wait for the launch, and
 * return its stdout (where `--bg` prints `backgrounded · <handle>`). stderr is
 * inherited so launch diagnostics still reach the terminal; only stdout — the
 * handle line — is captured. `encoding: "utf8"` makes `execFileSync` return a
 * string rather than a Buffer. Bounded by {@link LAUNCH_TIMEOUT_MS} and
 * {@link LAUNCH_MAX_BUFFER} because this runs synchronously on the board's input
 * path: either bound being hit throws, which the spawn edge treats as a launch
 * failure rather than hanging or crashing the board.
 */
export const realExec: ExecSeam = (command, args, options) =>
  execFileSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: LAUNCH_TIMEOUT_MS,
    maxBuffer: LAUNCH_MAX_BUFFER,
  });
