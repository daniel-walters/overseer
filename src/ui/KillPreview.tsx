import React from "react";
import { Box, Text } from "ink";
import type { KillPreview as KillPreviewData } from "../dispatch/kill.js";

interface KillPreviewProps {
  /** The live Issue whose agent this kill will stop, frozen at open time. */
  readonly preview: KillPreviewData;
}

/**
 * The modal kill preview: the last look before stopping a live agent. Pure
 * presentation — the keypress handling and the `claude stop` itself live in
 * {@link App}; this only names the Issue, spells out what confirm does, and shows
 * the confirm/cancel hint.
 *
 * The live-agent counterpart to {@link RedispatchPreview}: it acts on the single
 * Issue `K` was pressed on. Confirm stops the agent and writes *nothing* to the
 * Issue (ADR 0010) — so the Issue then orphans and the `R` flow recovers it. The
 * confirmation is the deliberate human gate before terminating a running agent.
 */
export function KillPreview({ preview }: KillPreviewProps) {
  const { issue } = preview;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Stop {issue.title}'s agent</Text>

      <Box marginTop={1}>
        <Text color="yellow">
          ⚠ This stops the running agent ({preview.handle}). Its work so far is
          left as-is.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Stops the agent only — no status is written, so the Issue becomes an
          orphan; recover it with R.
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter / y to stop · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
