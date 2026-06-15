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
  /**
   * Suppressed marker, present only on an awaiting `ready-for-agent` /
   * `ready-for-review` card whose last spawn launch failed this session
   * (CONTEXT.md, ADR 0011). Disjoint from {@link liveness} (opposite lanes), so
   * the two markers can never co-render on one card.
   */
  suppressed?: boolean;
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
 * not a failure (ADR 0008). An orphan reads loud (a yellow warning glyph + word):
 * the agent is genuinely gone and the card is stuck, recoverable with `R` — so it
 * is an attention signal, deliberately distinct from the quiet `unknown` dimming
 * (ADR 0009).
 */
const LIVENESS_MARKER: Record<Liveness, { text: string; color: string }> = {
  live: { text: "● live", color: "green" },
  unknown: { text: "○ unknown", color: "gray" },
  orphaned: { text: "⚠ orphaned", color: "yellow" },
};

/**
 * The suppressed marker, following the same own-line idiom as the liveness and
 * human-review markers. Red and `⊘` deliberately set it apart from the yellow
 * "needs a human" warning family (orphaned, deviation, conflict, non-convergence):
 * this is "nothing ran — fix the environment and reopen", not "an agent's work
 * needs your judgment" (ADR 0011). Edge-agnostic by design — the column already
 * tells you whether it is the implementor or reviewer edge.
 */
const SUPPRESSED_MARKER = "⊘ suppressed";

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({
  title,
  readyFor,
  humanReviewReason,
  liveness,
  suppressed,
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
      {liveness && !suppressed && (
        // Mirrors the human-review marker: its own truncating line under the
        // title, so the overlay never displaces the card's identity. Disjoint
        // lanes mean the scanner never sets both (ADR 0011); the `!suppressed`
        // guard is the Card's own last line of defence — if both fields ever
        // arrive, the card still reads as one coherent state (suppressed wins).
        <Text wrap="truncate-end" color={LIVENESS_MARKER[liveness].color}>
          {LIVENESS_MARKER[liveness].text}
        </Text>
      )}
      {suppressed && (
        // Its own truncating line, red — a launch-failed card parked this
        // session. Disjoint lanes mean this never renders alongside a liveness
        // marker (ADR 0011).
        <Text wrap="truncate-end" color="red">
          {SUPPRESSED_MARKER}
        </Text>
      )}
    </Box>
  );
}
