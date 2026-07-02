import { dirname, join } from "node:path";
import { writeStatus } from "../issueFile.js";
import type { FailureRecord } from "../dispatch/dispatch.js";
import { readAuditTarget, type AuditPreview } from "./auditReader.js";
import { classifyAuditability } from "./eligibility.js";
import { buildAuditorPrompt } from "./auditorPrompt.js";
import { runAudit } from "./audit.js";
import { recordingLogFailure, type FailedSet } from "../reactor/failedSet.js";
import type { AgentConfig } from "../agentConfig.js";
import type { Auditor } from "../ui/App.js";

/**
 * The I/O seams the production auditor injects into {@link runAudit}, passed in by
 * the CLI so the manual `c` audit is tested without launching real Claude. They
 * are the *same* spawn edge the dispatcher/reviewer use and the *same* shared
 * failed-set the Reactor's audit pass uses — a manual `c` and an auto-spawned
 * auditor launch identically (ADR 0026). Mirrors {@link import("../review/reviewer.js").ReviewerDeps},
 * minus the review-pass count and review config: the audit edge is a single pass
 * with no cap or non-convergence loop.
 */
export interface AuditorDeps {
  /**
   * Launch an auditor in `repo` with `prompt`, returning the handle parsed from
   * the launch stdout (or `undefined`); throws if the launch fails.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /**
   * The auditor agent runtime (model + effort) a manual `c` launches at — the
   * `[auditor]` config the CLI threads here (defaulting to **sonnet/medium**, ADR 0026),
   * the *same* value the Reactor's auto-auditor uses, so a hand-driven audit and
   * an automated one launch the auditor identically.
   */
  readonly agent?: AgentConfig;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /** Record a launched auditor's handle against its Issue key in the sidecar. */
  readonly recordHandle: (issueKey: string, handle: string) => void;
  /**
   * The session-scoped failed-set shared with the Reactor and the dispatcher. A
   * manual `c` launch that fails records `(path, audit)` here, so the next Reactor
   * reconcile subtracts that Issue and does not re-spawn its auditor this session
   * — a failed launch is a failed launch regardless of who triggered it (ADR 0011),
   * exactly as the manual `r` reviewer shares the set. The CLI injects the one
   * shared instance.
   */
  readonly failedSet: FailedSet;
}

/**
 * Build the production {@link Auditor} the App drives at the Issue level — the
 * manual audit crank (`c`), the audit counterpart to
 * {@link import("../review/reviewer.js").createReviewer}. It resolves a (PRD id,
 * Issue id) to that Issue's audit target, classifies its auditability for the
 * preview, and on confirm runs the flip-then-spawn edge: flip
 * `ready-for-audit → in-audit`, build the auditor prompt, and spawn `claude --bg`
 * in the Issue's repo — rolling back and logging any post-flip failure under the
 * shared `audit` edge key.
 *
 * The whole capture — Issue, eligibility, and the PRD context the prompt needs —
 * travels on the {@link AuditPreview} the App freezes, so `audit` builds the
 * prompt straight from its argument with no reader-side state to drift.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI by design, so `c` and confirm can race a deletion. `readAudit` reports a
 * vanished PRD/Issue as `undefined` (the preview renders nothing), and `audit`
 * no-ops when the previewed Issue is no longer auditable or when the flip fails —
 * neither may throw out of the Ink input handler and crash the board.
 */
export function createAuditor(root: string, deps: AuditorDeps): Auditor {
  return {
    readAudit(prdId: string, issueId: string): AuditPreview | undefined {
      const prdDir = join(root, prdId);
      const target = readAuditTarget(prdDir, issueId);
      if (!target) return undefined;
      return {
        issue: target.issue,
        eligibility: classifyAuditability(target.issue),
        prdTitle: target.prdTitle,
        prdBody: target.prdBody,
      };
    },

    audit(preview: AuditPreview): void {
      if (!preview.eligibility.auditable) return; // skip-and-report happens in the UI

      runAudit(preview.issue, {
        writeStatus,
        buildPrompt: (issue) =>
          buildAuditorPrompt({
            issue,
            prdTitle: preview.prdTitle,
            prdBody: preview.prdBody,
          }),
        spawn: deps.spawn,
        agent: deps.agent,
        // Route this manual `c` launch's failures through the shared failed-set
        // before the durable log, under the `audit` edge key — so a failed manual
        // audit is suppressed from the next reconcile exactly as the Reactor's
        // audit pass suppresses its own failures (the Issue's directory is the
        // `prdDir` the helper re-joins the bare filename with).
        logFailure: recordingLogFailure(
          deps.failedSet,
          dirname(preview.issue.path),
          deps.logFailure,
        ),
        recordHandle: deps.recordHandle,
      });
    },
  };
}
