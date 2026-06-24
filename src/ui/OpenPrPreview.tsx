import React from "react";
import { Box, Text } from "ink";
import type { OpenPrPreviewData } from "../dispatch/openPr.js";

// The preview data shape lives beside the orchestration (it's resolved domain
// data — branch / base / refusal), re-exported here so UI sites can name it
// alongside the component that renders it.
export type { OpenPrPreviewData };

interface OpenPrPreviewProps {
  readonly preview: OpenPrPreviewData;
}

/**
 * The modal Open PR preview: the pre-write plan for one `done` PRD. Pure
 * presentation — the keypress handling and the push/create themselves live in
 * {@link App}; this only renders the two outward actions (push the branch · open
 * the PR into the base) or the refusal, plus the confirm/cancel hint.
 *
 * The outward-write counterpart to {@link DispatchPreview} / {@link ReviewPreview}:
 * it shows exactly what will hit GitHub — a `git push` and a `gh pr create` —
 * before it happens, the deliberate human gate on the board's first GitHub writes.
 */
export function OpenPrPreview({ preview }: OpenPrPreviewProps) {
  const { prdTitle, branch, base, eligibility } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Open PR for {prdTitle}</Text>

      {eligibility.canOpen ? (
        <>
          <Box flexDirection="column" marginTop={1}>
            {preview.sliceCount !== undefined ? (
              <>
                <Text>
                  Open <Text color="cyan">{preview.sliceCount} stacked PRs</Text>{" "}
                  into <Text color="cyan">{base}</Text>
                </Text>
                <Text dimColor>
                  (pushes {preview.sliceCount} slice branches — not {branch})
                </Text>
              </>
            ) : (
              <>
                <Text>
                  Push <Text color="cyan">{branch}</Text> to{" "}
                  <Text color="cyan">origin</Text>
                </Text>
                <Text>
                  Open PR into <Text color="cyan">{base}</Text>
                </Text>
              </>
            )}
          </Box>

          <Box marginTop={1}>
            <Text color="yellow">
              ⚠ These are outward GitHub writes — they push your branch and open a
              PR on GitHub.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Enter / y to open PR · Esc to cancel</Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color="gray">Can't open a PR — {eligibility.reason}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc to dismiss</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
