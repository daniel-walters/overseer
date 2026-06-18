import React from "react";
import { Box, Text } from "ink";

/**
 * The frozen plan an Approve confirm acts on, and what the confirm modal renders.
 * Lives here beside the component (it is resolved domain data — the Issue's title,
 * its recorded merge handoff, and the derived feature branch), the same way
 * {@link import("./MarkDonePreview.js").MarkDonePreviewData} sits beside its preview.
 *
 * It carries both the human-facing plan strings the preview states **and** the
 * handoff the confirm hands to the merge — frozen together at `A`-press time so a
 * live re-scan under the open modal can never re-point the preview or the merge at
 * a different Issue (the same freeze the review/kill previews use).
 */
export interface ApprovePreviewData {
  /** The selected Issue's display title, named in the confirm copy. */
  readonly issueTitle: string;
  /** Absolute path to the Issue file the clean merge writes `status: done` to. */
  readonly issuePath: string;
  /** The repo every git command runs in. */
  readonly repo: string;
  /** The Issue's recorded worktree — merged from, then removed on a clean merge. */
  readonly worktree: string;
  /** The Issue's recorded branch — merged into the feature branch. */
  readonly branch: string;
  /** The PRD feature branch the worktree branch merges into (`featureBranchName`). */
  readonly featureBranch: string;
}

interface ApprovePreviewProps {
  readonly preview: ApprovePreviewData;
}

/**
 * The modal Approve preview: the confirm gate before the board's first
 * human-triggered *merge* (PRD: Approve from Board, ADR 0021). Pure presentation —
 * the keypress handling, the merge, and the `done` write live in {@link App} via the
 * injected seam; this only **states the plan**.
 *
 * It states the plan and does **not** render a diff (PRD user story 16 / out of
 * scope): merge `<branch>` → `<feature-branch>`, mark `<issue>` done, remove the
 * worktree. Like the `X` (Delete) and the dispatch/review previews, it is a clean
 * action statement, not a diff view — inspecting the actual change before approving
 * is a separate capability belonging with the detail view.
 *
 * It sits in the heavy `K`/`R`/`X` family: a merge into the feature branch is an
 * outward, not-trivially-reversible action, so the confirm is an "is this right?"
 * beat before it runs (the shift-keyed `A` reinforces that). Unlike `X` it is not
 * *destructive* — nothing is unrecoverably erased — so the tone is plain, not the
 * red strongest-warning copy.
 */
export function ApprovePreview({ preview }: ApprovePreviewProps) {
  const { issueTitle, branch, featureBranch, worktree } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Approve {issueTitle}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          Merge <Text color="cyan">{branch}</Text> →{" "}
          <Text color="cyan">{featureBranch}</Text>.
        </Text>
        <Text>
          Mark <Text color="cyan">{issueTitle}</Text> done.
        </Text>
        <Text>
          Remove worktree <Text color="cyan">{worktree}</Text>.
        </Text>
        <Text dimColor>
          Approve once the work is ready to merge. If the worktree is dirty or the
          merge conflicts, nothing changes — commit or resolve in the worktree first.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter / y to approve · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
