import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor, HumanReviewReason } from "../model.js";

interface CardProps {
  title: string;
  /** Routing badge, present only while the card is in the ready column. */
  readyFor?: ReadyFor;
  /** Escalation marker, present only while the card is in human-review. */
  humanReviewReason?: HumanReviewReason;
  /** Whether this card is the current selection. */
  selected?: boolean;
}

const BADGE: Record<ReadyFor, string> = {
  human: "🧑",
  agent: "🤖",
};

/**
 * The escalation marker shown on a human-review card: a glyph for at-a-glance
 * scanning plus the reason word so the three exits read distinctly. Kept short
 * because the card line truncates — the marker is the attention signal that
 * earns its place ahead of the title.
 */
const REASON_MARKER: Record<HumanReviewReason, string> = {
  deviation: "⚠ deviation",
  "non-convergence": "↻ non-convergence",
  conflict: "✗ conflict",
};

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({
  title,
  readyFor,
  humanReviewReason,
  selected = false,
}: CardProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={selected ? "cyan" : undefined}
      paddingX={1}
      width="100%"
    >
      <Text wrap="truncate-end" inverse={selected} bold={selected}>
        {selected ? "▶ " : ""}
        {readyFor ? `${BADGE[readyFor]} ` : ""}
        {title}
      </Text>
      {humanReviewReason && (
        // The marker rides its own line so it never crowds the title out of the
        // narrow card under truncation — the title still identifies the card.
        <Text wrap="truncate-end" color="yellow">
          {REASON_MARKER[humanReviewReason]}
        </Text>
      )}
    </Box>
  );
}
