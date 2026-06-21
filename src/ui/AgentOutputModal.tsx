import React from "react";
import { Box, Text } from "ink";
import type { AgentOutput } from "./agentOutputReader.js";
import { scrollDetail } from "./detailScroll.js";

/**
 * The rows the modal spends on chrome rather than output: the round border (top +
 * bottom = 2), the title (1) with its trailing margin (1), the above-affordance row
 * (1), the below-affordance row (1), and the close/scroll hint (1) with its leading
 * margin (1). The {@link App} subtracts this from the terminal height to size the
 * output region it scrolls, so the budget lives in one place beside the layout it
 * describes — the raw-output twin of `DETAIL_MODAL_CHROME_ROWS`.
 */
export const AGENT_OUTPUT_MODAL_CHROME_ROWS = 8;

interface AgentOutputModalProps {
  /** The resolved agent output to display: its Issue title and raw `claude logs` stdout. */
  readonly output: AgentOutput;
  /**
   * The scroll position over the output's lines, owned by {@link App} (which clamps
   * it on each `j`/`k`/arrow). Defaults to the top.
   */
  readonly scrollOffset?: number;
  /**
   * How many rows the output region may show. Output taller than this is windowed
   * and gains overflow affordances; shorter shows whole. Defaults to unbounded so
   * output that fits never windows (and tests that don't exercise scrolling render
   * the whole thing).
   */
  readonly viewportRows?: number;
  /**
   * The output's already-split lines, supplied by {@link App} so the split runs once
   * per frame (the App also needs the lines to size the scroll window) rather than
   * once here and once there. Omitted by standalone tests, which split `output.output`
   * directly — matching the {@link import("./DetailModal.js").DetailModal} pattern.
   */
  readonly lines?: readonly string[];
}

/**
 * The full-screen agent-output modal: the selected `live` Issue's recent terminal
 * output, opened by `o` (CONTEXT.md → Agent output, ADR 0023). A sibling of the `v`
 * {@link import("./DetailModal.js").DetailModal} that shares its scroll primitive but
 * **not** its markdown render: agent output is raw terminal scrollback, shown as-is,
 * never run through the marked-terminal renderer (ADR 0014) that would mangle it.
 * Pure presentation — the open/close/scroll keypress handling lives in {@link App},
 * mirroring the detail modal's dismissal contract; this only renders the
 * {@link AgentOutput} a `readAgentOutput` (the output seam) already resolved, windowed
 * at the scroll offset the App tracks.
 *
 * The output is split into lines on `\n` and windowed through {@link scrollDetail}:
 * only the slice that fits `viewportRows` renders, and overflow affordances ("more
 * above"/"more below") signal unread content so the user knows to scroll. ANSI in the
 * output passes through as-is (the terminal interprets it), matching what the agent's
 * own terminal shows.
 *
 * Empty (or whitespace-only) output shows a quiet `(no output yet)` placeholder rather
 * than a blank modal — the agent spawned but has printed nothing yet (mirroring the
 * detail modal's `(no body)`). The dismiss hint reads as a *close/scroll* hint, not a
 * live tail: the output is a frozen snapshot, and close-and-reopen is the refresh.
 */
export function AgentOutputModal({
  output,
  scrollOffset = 0,
  viewportRows,
  lines: suppliedLines,
}: AgentOutputModalProps) {
  // Raw scrollback: split on newlines, never markdown-rendered. Strip all trailing
  // newlines (not just one) so a `claude logs` output ending in "\n\n\n" doesn't
  // inflate the line count and allow scrolling into visually blank rows below all
  // real content. Use App-supplied lines when present (same array App sized
  // maxOffset from, so the clamp and this window can't drift — the DetailModal pattern).
  const lines = suppliedLines ?? output.output.replace(/\n+$/, "").split("\n");
  // "Has output" keys off the same lines we window — not a separate trim() of the raw
  // string — so the placeholder branch and the windowed render can never disagree.
  // A whitespace-only multi-line input (e.g. "   \n\n  ") would leave trim() empty but
  // lines non-empty; keying off lines keeps hasOutput and scrollDetail in sync.
  const hasOutput = lines.some((l) => l.trim().length > 0);
  const rows = viewportRows ?? lines.length;
  const window = scrollDetail(lines, scrollOffset, rows);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{output.title}</Text>

      <Box marginTop={1} minHeight={1}>
        {window.hasAbove ? <Text dimColor>↑ more above</Text> : <Text> </Text>}
      </Box>

      <Box flexDirection="column">
        {hasOutput ? (
          <Text>{window.visible.join("\n")}</Text>
        ) : (
          <Text dimColor italic>
            (no output yet)
          </Text>
        )}
      </Box>

      <Box minHeight={1}>
        {window.hasBelow ? <Text dimColor>↓ more below</Text> : <Text> </Text>}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>j / k / arrows to scroll · o / Esc to close · q to quit</Text>
      </Box>
    </Box>
  );
}
