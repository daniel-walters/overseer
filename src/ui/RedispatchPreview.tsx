import React from "react";
import { Box, Text } from "ink";
import type { RedispatchPreview as RedispatchPreviewData } from "../dispatch/rollback.js";

interface RedispatchPreviewProps {
  /** The orphaned Issue this re-dispatch will roll back, frozen at open time. */
  readonly preview: RedispatchPreviewData;
}

/**
 * The modal re-dispatch preview: the last look before recovering an orphan.
 * Pure presentation — the keypress handling and the rollback itself live in
 * {@link App}; this only names the orphan, spells out what confirm does, and
 * shows the confirm/cancel hint.
 *
 * The orphan counterpart to {@link DispatchPreview} / {@link ReviewPreview}: it
 * acts on the single Issue `R` was pressed on. Confirm spawns nothing — it rolls
 * the active status back to its awaiting value so the normal spawn edge re-picks
 * the Issue up (the Reactor if auto-run is on, `d`/`r` if off). The confirmation
 * is the deliberate human safety check against a false-dead verdict (ADR 0009).
 */
export function RedispatchPreview({ preview }: RedispatchPreviewProps) {
  const { issue } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Re-dispatch {issue.title}</Text>

      <Box marginTop={1}>
        <Text color="yellow">
          ⚠ This Issue is orphaned — its agent is no longer alive.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Rolls the status back onto its frontier (no agent is spawned here); the
          normal spawn edge — the Reactor if auto-run is on, d / r if off —
          re-picks it up.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter / y to re-dispatch · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
