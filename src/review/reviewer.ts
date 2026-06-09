import { basename, join } from "node:path";
import { writeStatus } from "../dispatch/statusWriter.js";
import { featureBranchName } from "../dispatch/gitSetup.js";
import type { FailureRecord } from "../dispatch/dispatch.js";
import { readReviewTarget, type ReviewPreview, type ReviewTarget } from "./reviewReader.js";
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
  /** Launch a reviewer in `repo` with `prompt`; throws if the launch fails. */
  readonly spawn: (repo: string, prompt: string) => void;
  /** Append a spawn-failure record to the durable dispatch log. */
  readonly logFailure: (record: FailureRecord) => void;
}

/**
 * Build the production {@link Reviewer} the App drives at the Issue level. It
 * resolves a (PRD id, Issue id) to that Issue's review target, classifies its
 * reviewability for the preview, and on confirm runs the flip-then-spawn edge:
 * flip `ready-for-review → in-review`, build the reviewer prompt, and spawn
 * `claude --bg` in the Issue's repo — rolling back and logging any post-flip
 * failure.
 *
 * `readReview` caches the {@link ReviewTarget} it read so `review` can build the
 * prompt (which needs the PRD body and feature branch) without re-reading the
 * root — the App always confirms the very Issue it just previewed.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI by design, so `r` and confirm can race a deletion. `readReview`
 * reports a vanished PRD/Issue as `undefined` (the preview renders nothing), and
 * `review` no-ops when nothing was cached, when the previewed Issue is
 * ineligible, or when the flip fails — none of which may throw out of the Ink
 * input handler and crash the board.
 */
export function createReviewer(root: string, deps: ReviewerDeps): Reviewer {
  /** The PRD dir + target behind the last review read, for prompt building. */
  let lastRead: { prdDir: string; target: ReviewTarget } | undefined;

  return {
    readReview(prdId: string, issueId: string): ReviewPreview | undefined {
      const prdDir = join(root, prdId);
      const target = readReviewTarget(prdDir, issueId);
      if (!target) {
        lastRead = undefined;
        return undefined;
      }
      lastRead = { prdDir, target };
      return { issue: target.issue, eligibility: classifyReviewability(target.issue) };
    },

    review(preview: ReviewPreview): void {
      if (lastRead === undefined) return; // nothing was read ⇒ nothing to review
      if (!preview.eligibility.reviewable) return; // skip-and-report happens in the UI
      const { prdDir, target } = lastRead;
      const featureBranch = featureBranchName(basename(prdDir));

      runReview(preview.issue, {
        writeStatus,
        buildPrompt: (issue) =>
          buildReviewerPrompt({
            issue,
            prdTitle: target.prdTitle,
            prdBody: target.prdBody,
            featureBranch,
          }),
        spawn: deps.spawn,
        logFailure: deps.logFailure,
      });
    },
  };
}
