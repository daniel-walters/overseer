import React from "react";
import { Box, Text } from "ink";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";

interface ReviewPreviewProps {
  /** The classified review preview: the target Issue and its eligibility. */
  readonly preview: ReviewPreviewData;
}

/**
 * The modal review preview: the pre-spawn plan for one selected Issue. Pure
 * presentation — the keypress handling and the spawn itself live in {@link App};
 * this only renders the plan (or the skip reason) and the confirm/cancel hint.
 *
 * The review counterpart to {@link DispatchPreview}: dispatch previews a whole
 * PRD's frontier, while review previews the single Issue `r` was pressed on. An
 * ineligible Issue shows why it can't be reviewed and offers only a dismiss —
 * there is nothing to confirm.
 */
export function ReviewPreview({ preview }: ReviewPreviewProps) {
  const { issue, eligibility } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Review {issue.title}</Text>

      {eligibility.reviewable ? (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text>
              Worktree: <Text color="cyan">{issue.worktree}</Text>
            </Text>
            <Text>
              Branch: <Text color="cyan">{issue.branch}</Text>
            </Text>
          </Box>

          {issue.deviation !== undefined && (
            <Box marginTop={1}>
              <Text color="yellow">
                ⚠ A deviation was recorded — this review goes to human-review, not
                auto-merge.
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>
              Spawns a reviewer: /code-review loop (medium, ≤3 passes), then merge
              to the feature branch on a clean pass or escalate to human-review.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Enter / y to review · Esc to cancel</Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color="gray">Can't review this Issue — {eligibility.reason}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc to dismiss</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
