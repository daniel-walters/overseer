import { dirname, join } from "node:path";
import { writeStatus } from "../issueFile.js";
import type { FailureRecord } from "../dispatch/dispatch.js";
import { readReviewTarget, type ReviewPreview } from "./reviewReader.js";
import { classifyReviewability } from "./eligibility.js";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { driveReviewPass } from "./review.js";
import { recordingLogFailure, type FailedSet } from "../reactor/failedSet.js";
import type { ReviewConfig } from "./reviewConfig.js";
import type { AgentConfig } from "../agentConfig.js";
import type { Reviewer } from "../ui/App.js";

/**
 * The I/O seams the production reviewer injects into {@link runReview}, passed
 * in by the CLI so review is tested without launching real Claude. The
 * status-writer and prompt builder are not seams — they are pure/fs-internal —
 * so only the genuinely external edges (the `claude --bg` spawn and the failure
 * log) are injected, exactly as the dispatcher does. They are the *same* spawn
 * edge the dispatcher uses: a reviewer is just another `claude --bg` agent.
 */
export interface ReviewerDeps {
  /**
   * Launch a reviewer in `repo` with `prompt`, returning the handle parsed from
   * the launch stdout (or `undefined`); throws if the launch fails.
   */
  readonly spawn: (
    repo: string,
    prompt: string,
    agent?: AgentConfig,
  ) => string | undefined;
  /**
   * The reviewer agent runtime (model + effort) a manual `r` launches at — the
   * `[reviewer]` config the CLI threads here, the *same* value the Reactor's
   * auto-reviewer uses, so a hand-driven review and an automated one launch the
   * reviewer identically. Optional: omitted ⇒ inherit the launcher's defaults.
   */
  readonly agent?: AgentConfig;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /**
   * Record a launched reviewer's handle — and the AI-review pass this press
   * drives — against its Issue key in the sidecar (ADR 0008 / 0018).
   */
  readonly recordHandle: (
    issueKey: string,
    handle: string,
    reviewPass?: number,
  ) => void;
  /**
   * Read the AI-review pass already recorded for an Issue, or `undefined` when
   * none is (a fresh `ready-for-review` Issue). A manual `r` press is one pass
   * exactly like an auto-reconcile pass (ADR 0018): it reads `N` here, then
   * either spawns pass `N+1` (recording it) or — at the cap — escalates to
   * human-review with `non-convergence` instead of spawning. The CLI injects the
   * same sidecar projection the Reactor reads, so a hand-driven loop steps through
   * the count identically to the automated one.
   */
  readonly readReviewPass: (issueKey: string) => number | undefined;
  /**
   * The session-scoped failed-set shared with the Reactor and the dispatcher. A
   * manual `r` launch that fails records `(path, reviewer)` here, so the next
   * Reactor reconcile subtracts that Issue and does not re-spawn its reviewer
   * this session — a failed launch is a failed launch regardless of who
   * triggered it (ADR 0011). The CLI injects the one shared instance.
   */
  readonly failedSet: FailedSet;
  /**
   * The resolved review knobs (pass cap + effort) the reviewer prompt embeds.
   * The CLI threads {@link import("../config.js").Config.review} here so the
   * manual `r` reviewer and the Reactor's auto-reviewer build identical briefs.
   */
  readonly review: ReviewConfig;
}

/**
 * Build the production {@link Reviewer} the App drives at the Issue level. It
 * resolves a (PRD id, Issue id) to that Issue's review target, classifies its
 * reviewability for the preview, and on confirm runs the flip-then-spawn edge:
 * flip `ready-for-review → in-review`, build the reviewer prompt, and spawn
 * `claude --bg` in the Issue's repo — rolling back and logging any post-flip
 * failure.
 *
 * The whole capture — Issue, eligibility, and the PRD context the prompt needs
 * — travels on the {@link ReviewPreview} the App freezes, so `review` builds the
 * prompt straight from its argument with no reader-side state to drift: the
 * Issue acted on and the PRD context in its prompt always come from one read.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI by design, so `r` and confirm can race a deletion. `readReview`
 * reports a vanished PRD/Issue as `undefined` (the preview renders nothing), and
 * `review` no-ops when the previewed Issue is ineligible or when the flip fails
 * — neither may throw out of the Ink input handler and crash the board.
 */
export function createReviewer(root: string, deps: ReviewerDeps): Reviewer {
  return {
    readReview(prdId: string, issueId: string): ReviewPreview | undefined {
      const prdDir = join(root, prdId);
      const target = readReviewTarget(prdDir, issueId);
      if (!target) return undefined;
      return {
        issue: target.issue,
        eligibility: classifyReviewability(target.issue),
        prdTitle: target.prdTitle,
        prdBody: target.prdBody,
      };
    },

    review(preview: ReviewPreview): void {
      if (!preview.eligibility.reviewable) return; // skip-and-report happens in the UI

      // A manual `r` press is one pass of the Reactor-owned loop (ADR 0018):
      // `driveReviewPass` reads the recorded count and either spawns pass `N+1`
      // (recording it) or escalates to human-review at the cap — the same decision
      // the auto-reconcile makes, so stepping the loop by hand matches the
      // automated cascade exactly.
      driveReviewPass(preview.issue, {
        readReviewPass: deps.readReviewPass,
        review: deps.review,
        writeStatus,
        buildPrompt: (issue) =>
          buildReviewerPrompt({
            issue,
            prdTitle: preview.prdTitle,
            prdBody: preview.prdBody,
            review: deps.review,
          }),
        spawn: deps.spawn,
        agent: deps.agent,
        // Route this manual `r` launch's failures through the shared failed-set
        // before the durable log. The Issue's `path` is `prdDir/filename`, so its
        // directory is the `prdDir` the helper re-joins the bare filename with —
        // the same full-path key the Reactor reads, so a failed manual review is
        // suppressed from the next reconcile under the reviewer edge.
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
