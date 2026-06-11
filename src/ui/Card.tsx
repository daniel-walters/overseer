import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor, HumanReviewReason, Liveness } from "../model.js";

interface CardProps {
  title: string;
  /** Routing badge, present only while the card is in the ready column. */
  readyFor?: ReadyFor;
  /** Escalation marker, present only while the card is in human-review. */
  humanReviewReason?: HumanReviewReason;
  /**
   * Liveness marker, present only on a dispatched in-progress / in-review card
   * (CONTEXT.md, ADR 0008): whether its agent is still in Claude's live set.
   */
  liveness?: Liveness;
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

/**
 * The liveness marker, mirroring the human-review reason marker's treatment: a
 * glyph plus the verdict word on its own truncating line. A live agent reads
 * green (it is working); an unknown one reads dim/gray — deliberately quiet, not
 * an alarm, because unknown is the honest "this session can't see it" verdict,
 * not a failure (ADR 0008).
 */
const LIVENESS_MARKER: Record<Liveness, { text: string; color: string }> = {
  live: { text: "● live", color: "green" },
  unknown: { text: "○ unknown", color: "gray" },
};

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({
  title,
  readyFor,
  humanReviewReason,
  liveness,
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
      {liveness && (
        // Mirrors the human-review marker: its own truncating line under the
        // title, so the overlay never displaces the card's identity.
        <Text wrap="truncate-end" color={LIVENESS_MARKER[liveness].color}>
          {LIVENESS_MARKER[liveness].text}
        </Text>
      )}
    </Box>
  );
}
