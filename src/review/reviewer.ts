import { basename, join } from "node:path";
import { writeStatus } from "../issueFile.js";
import { featureBranchName } from "../dispatch/gitSetup.js";
import type { FailureRecord } from "../dispatch/dispatch.js";
import { readReviewTarget, type ReviewPreview } from "./reviewReader.js";
import { classifyReviewability } from "./eligibility.js";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { runReview } from "./review.js";
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
  readonly spawn: (repo: string, prompt: string) => string | undefined;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
  /** Record a launched reviewer's handle against its Issue key in the sidecar. */
  readonly recordHandle: (issueKey: string, handle: string) => void;
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
        // basename(prdDir) === prdId; derived the same way the dispatcher does
        // so the review-merge target and the dispatch worktree base agree.
        featureBranch: featureBranchName(basename(prdDir)),
      };
    },

    review(preview: ReviewPreview): void {
      if (!preview.eligibility.reviewable) return; // skip-and-report happens in the UI

      runReview(preview.issue, {
        writeStatus,
        buildPrompt: (issue) =>
          buildReviewerPrompt({
            issue,
            prdTitle: preview.prdTitle,
            prdBody: preview.prdBody,
            featureBranch: preview.featureBranch,
          }),
        spawn: deps.spawn,
        logFailure: deps.logFailure,
        recordHandle: deps.recordHandle,
      });
    },
  };
}
