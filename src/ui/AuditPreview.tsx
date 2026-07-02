import React from "react";
import { Box, Text } from "ink";
import type { AuditPreview as AuditPreviewData } from "../audit/auditReader.js";

interface AuditPreviewProps {
  /** The classified audit preview: the target Issue and its auditability. */
  readonly preview: AuditPreviewData;
}

/**
 * The modal audit preview: the pre-spawn plan for one selected Issue. Pure
 * presentation — the keypress handling and the spawn itself live in {@link App};
 * this only renders the plan (or the skip reason) and the confirm/cancel hint.
 *
 * The audit counterpart to {@link ReviewPreview}: where review previews the
 * single Issue `r` was pressed on, audit previews the single `ready-for-audit`
 * Issue `c` was pressed on. An ineligible Issue shows why it can't be audited and
 * offers only a dismiss — there is nothing to confirm. The auditor never merges,
 * so the preview shows only the worktree (the diff it checks out), not the branch.
 */
export function AuditPreview({ preview }: AuditPreviewProps) {
  const { issue, eligibility } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Audit {issue.title}</Text>

      {eligibility.auditable ? (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text>
              Worktree: <Text color="cyan">{issue.worktree}</Text>
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>
              Spawns an auditor: checks out the worktree, compares the diff against
              the plan, records a deviation only on a meaningful divergence, then
              flips to ready-for-review.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Enter / y to audit · Esc to cancel</Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color="gray">Can't audit this Issue — {eligibility.reason}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc to dismiss</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
