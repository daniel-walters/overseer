import { hasValue, type DispatchIssue } from "../dispatch/reader.js";
import { spawnWithFlip, type FailureRecord } from "../dispatch/failureLog.js";
import { Status } from "../dispatch/status.js";
import type { AgentConfig } from "../agentConfig.js";

/**
 * The I/O seams a single audit depends on, injected so the flip-then-spawn edge
 * is tested without touching the filesystem or spawning a real agent. Mirrors the
 * review {@link import("../review/review.js").ReviewDeps}, minus the review-pass
 * count: the audit edge is a single pass with no cap or non-convergence loop (ADR
 * 0026), so there is no pass to read, record, or escalate.
 */
export interface AuditDeps {
  /** Rewrite the Issue file's `status` frontmatter, preserving the rest. */
  readonly writeStatus: (path: string, status: string) => void;
  /** Build the auditor prompt for the Issue under audit. */
  readonly buildPrompt: (issue: DispatchIssue) => string;
  /**
   * Launch an auditor in `repo` with the built `prompt`, returning the handle
   * parsed from the launch stdout (or `undefined`). Throws on failure.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /**
   * The auditor agent runtime (model + effort) this pass launches at. Optional:
   * omitted ⇒ inherit the launcher's model/effort. In production the auditor edge
   * defaults its model to `opus` (ADR 0026), threaded in by the caller.
   */
  readonly agent?: AgentConfig;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /** Record a launched auditor's handle against its Issue key in the sidecar. */
  readonly recordHandle: (issueKey: string, handle: string) => void;
}

/**
 * Spawn an auditor for one Issue — the third spawn edge (ADR 0026), the audit
 * counterpart to {@link import("../dispatch/dispatch.js").runDispatch} and
 * {@link import("../review/review.js").runReview}:
 *
 * 1. Flip the Issue `ready-for-audit → in-audit` *before* spawning. The status is
 *    the idempotency lock (ADR 0002): by the time the flip lands, the Issue is off
 *    the `ready-for-audit` frontier, so a second `c` press (or the Reactor) can't
 *    double-spawn it.
 * 2. Spawn `claude --bg` in the Issue's repo with the auditor prompt.
 * 3. If the spawn throws *after* the flip, roll the Issue back to
 *    `ready-for-audit` (so the board never shows an in-audit Issue with no
 *    auditor) and append a record to the durable failure log under the `audit`
 *    edge.
 *
 * Total and best-effort throughout (it runs synchronously inside the Ink input
 * handler and the watcher callback): neither a vanished Issue file nor an
 * unwritable log may escape and crash the board.
 *
 * An Issue reaching the spawn with no `repo` recorded can't host an agent, so it
 * is left untouched — not flipped, not spawned. The eligibility classifier gates
 * this upstream; the guard here keeps the edge itself total.
 */
export function runAudit(issue: DispatchIssue, deps: AuditDeps): void {
  const repo = issue.repo;
  if (!hasValue(repo)) return;

  spawnWithFlip({
    edge: "audit",
    issue,
    repo,
    awaiting: Status.READY_FOR_AUDIT,
    active: Status.IN_AUDIT,
    writeStatus: deps.writeStatus,
    buildPrompt: () => deps.buildPrompt(issue),
    spawn: deps.spawn,
    agent: deps.agent,
    logFailure: deps.logFailure,
    recordHandle: deps.recordHandle,
  });
}
