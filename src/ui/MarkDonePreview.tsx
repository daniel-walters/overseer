import React from "react";
import { Box, Text } from "ink";

/**
 * The frozen plan a Mark done confirm acts on, and what the confirm modal renders.
 * Lives here beside the component (it is resolved domain data — the Issue's title
 * + file path), the same way {@link DeletePreviewData} sits beside its preview.
 */
export interface MarkDonePreviewData {
  /** The selected Issue's display title, named in the confirm copy. */
  readonly issueTitle: string;
  /** Absolute path to the Issue file the confirm writes `status: done` to. */
  readonly issuePath: string;
}

interface MarkDonePreviewProps {
  readonly preview: MarkDonePreviewData;
}

/**
 * The modal Mark done preview: the confirm gate before the board's first
 * human-triggered status flip with no spawn behind it (CONTEXT.md → mark done).
 * Pure presentation — the keypress handling and the `writeStatus` itself live in
 * {@link App}; this only renders the confirm copy (the Issue title and the
 * `ready-for-human → done` transition).
 *
 * **Thinner than its twins** ({@link ReviewPreview}, {@link DeletePreview}): there
 * is no external state to resolve (no git, no gh, no Issue count) — so the
 * "preview" is purely the confirm copy. And unlike Delete's strongest-warning
 * copy, its confirm is an "is the manual work actually finished?" intent beat, not
 * a safety net against irreversibility: a status flip is cheap and trivially
 * reversible (re-edit the field), so the tone is plain, not a red warning.
 */
export function MarkDonePreview({ preview }: MarkDonePreviewProps) {
  const { issueTitle } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Mark {issueTitle} done</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          Advance this Issue <Text color="cyan">ready-for-human → done</Text>.
        </Text>
        <Text dimColor>
          Mark it done once the manual work is finished. Reversible — re-edit the
          status field to undo.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter / y to mark done · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
