import React from "react";
import { Box, Text } from "ink";
import type { DeletePreviewData } from "../dispatch/deletePrd.js";

// The preview data shape lives beside the orchestration (it's resolved domain
// data — title + Issue count), re-exported here so UI sites can name it alongside
// the component that renders it.
export type { DeletePreviewData };

interface DeletePreviewProps {
  readonly preview: DeletePreviewData;
}

/**
 * The modal Delete preview: the confirm gate before the board's first destructive
 * write to the watched root (ADR 0016). Pure presentation — the keypress handling
 * and the `rm -rf` itself live in {@link App}; this only renders what will be
 * destroyed (the PRD + its Issue files) and the **strongest** warning of the modal
 * family: the delete is permanent and unrecoverable (the root is not a git repo,
 * so there is no `git restore`).
 *
 * The destructive counterpart to {@link OpenPrPreview}: where Open PR previews an
 * outward GitHub write, this previews an irreversible local removal — the
 * deliberate-friction safety net the `done`-gate and shift-keyed `X` rely on. Full
 * warning copy is a follow-up Issue; this carries the irreversibility plainly.
 */
export function DeletePreview({ preview }: DeletePreviewProps) {
  const { prdTitle, issueCount } = preview;
  const issueWord = issueCount === 1 ? "Issue" : "Issues";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">
        Delete {prdTitle}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          Remove the whole PRD directory — <Text color="cyan">prd.md</Text>,{" "}
          <Text color="cyan">
            {issueCount} {issueWord}
          </Text>
          , and every other file in it.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color="red">
          ⚠ This is permanent and unrecoverable — the root is not a git repo, so
          there is no way to restore it.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter / y to delete · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
