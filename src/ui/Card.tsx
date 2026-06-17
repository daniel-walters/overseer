import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor, HumanReviewReason, Liveness, LinkedPr } from "../model.js";
import { REASON_MARKER } from "../model.js";

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
  /**
   * Malformed-status marker, present only on a backlog card the scanner folded
   * there because its authored `status` was missing or unrecognised (CONTEXT.md,
   * ADR 0003). The loud marker keeps the data error triageable now that the
   * Unsorted column is gone — distinct from an ordinary backlog card. In the
   * yellow "needs a human" warning family (a frontmatter fix), never co-occurring
   * with the other markers (it rides the backlog lane, they ride other lanes).
   */
  malformedStatus?: boolean;
  /**
   * Linked PR marker, present only on a `done` PRD card whose live `gh` query
   * found a PR for its derived feature branch (CONTEXT.md, ADR 0013). Three-state:
   * *open*, *merged*, or — its absence — *no PR* (no marker). A PRD-level overlay,
   * disjoint from the Issue-level markers above (a PRD card carries no `readyFor` /
   * liveness / suppressed / human-review marker), so it never co-renders with them.
   */
  linkedPr?: LinkedPr;
  /**
   * Needs-review marker, present only on a PRD card with ≥1 Issue parked in
   * `human-review` (CONTEXT.md; {@link import("../model.js").derivePrdNeedsReview}).
   * The first Issue→PRD roll-up marker and the first marker an in-progress PRD
   * carries — it tells the board "this PRD is blocked on you" without zooming.
   * A PRD-level marker like {@link linkedPr}, disjoint from the Issue-level
   * markers above (a PRD card carries none of them) and disjoint from the
   * `done`-only Linked PR marker (needs-review implies not-`done`), so it
   * co-renders with neither.
   */
  needsReview?: boolean;
  /** Whether this card is the current selection. */
  selected?: boolean;
}

const BADGE: Record<ReadyFor, string> = {
  human: "🧑",
  agent: "🤖",
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

/**
 * The malformed-status marker, following the same own-line idiom as the other
 * markers. Yellow and `⚠` place it in the "needs a human" warning family (like
 * orphaned and the human-review reasons): the Issue's `status` frontmatter is
 * missing or unrecognised and a human must fix it — a data error, not the red
 * `⊘ suppressed` "nothing ran" category. Folding the Unsorted column into backlog
 * must not lose this triage signal, so the marker stays loud (CONTEXT.md, ADR 0003).
 */
const MALFORMED_STATUS_MARKER = "⚠ bad status";

/**
 * The Linked PR marker on a `done` PRD card, following the same own-line idiom as
 * the other markers (CONTEXT.md, ADR 0013). Three-state: *open* reads cyan (a PR
 * exists, awaiting merge — a neutral "there's something here"), *merged* reads
 * green (the real end-of-lifecycle signal: the out-of-scope default-branch merge
 * finally happened — the "good, done" state). *No PR* is this marker's absence.
 * Each carries its own glyph + word so the two states never read as one another.
 * A PRD-level marker, disjoint from the Issue-level marker families, so it never
 * co-renders with them.
 */
const LINKED_PR_MARKER: Record<LinkedPr["state"], { text: string; color: string }> = {
  open: { text: "◆ PR open", color: "cyan" },
  merged: { text: "✔ PR merged", color: "green" },
};

/**
 * The needs-review marker on a PRD card with ≥1 Issue in `human-review`, following
 * the same own-line truncating idiom as the other markers (CONTEXT.md). Yellow and
 * `⚠` place it in the "needs a human" warning family — the same family as the
 * human-review reason markers it rolls up — so the board reads it as "blocked on
 * you". A PRD-level marker, disjoint from the Issue-level marker families and from
 * the `done`-only Linked PR marker, so it co-renders with none of them.
 */
const NEEDS_REVIEW_MARKER = "⚠ needs review";

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({
  title,
  readyFor,
  humanReviewReason,
  liveness,
  suppressed,
  malformedStatus,
  linkedPr,
  needsReview,
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
      <Text wrap="truncate-end">
        {readyFor ? `${BADGE[readyFor]} ` : ""}
        {title}
      </Text>
      {humanReviewReason && !suppressed && (
        // The marker rides its own line so it never crowds the title out of the
        // narrow card under truncation — the title still identifies the card. The
        // `!suppressed` guard is the Card's last line of defence, applied to every
        // marker uniformly (see liveness below): disjoint lanes mean the scanner
        // never co-sets it (ADR 0011), but if both fields ever arrive the card
        // still reads as one coherent state — suppressed wins.
        <Text wrap="truncate-end" color="yellow">
          {REASON_MARKER[humanReviewReason]}
        </Text>
      )}
      {liveness && !suppressed && (
        // Mirrors the human-review marker: its own truncating line under the
        // title, so the overlay never displaces the card's identity. Same
        // `!suppressed` last-line-of-defence guard — if both fields ever arrive,
        // the card still reads as one coherent state (suppressed wins).
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
      {malformedStatus && (
        // Its own truncating line, yellow — a backlog card whose status frontmatter
        // is missing or unrecognised. Rides the backlog lane, disjoint from every
        // other marker's lane, so it never co-renders with one (ADR 0003).
        <Text wrap="truncate-end" color="yellow">
          {MALFORMED_STATUS_MARKER}
        </Text>
      )}
      {linkedPr && !needsReview && (
        // Its own truncating line — a `done` PRD's Linked PR overlay. A PRD-level
        // marker (the Issue-level fields above are never set on a PRD card), so it
        // co-renders with none of them; cyan for open, green for merged (ADR 0013).
        // The `!needsReview` guard is the last line of defence between the two
        // PRD-level markers: their lanes are disjoint (Linked PR is `done`-only,
        // needs-review implies not-`done`), so the scanner never co-sets them, but
        // even handed both the card reads as one coherent state — needs-review wins.
        <Text wrap="truncate-end" color={LINKED_PR_MARKER[linkedPr.state].color}>
          {LINKED_PR_MARKER[linkedPr.state].text}
        </Text>
      )}
      {needsReview && (
        // Its own truncating line, yellow — a PRD with ≥1 Issue parked in
        // `human-review`, rolled up to the board so it reads "blocked on you"
        // without zooming. A PRD-level marker, disjoint from the Issue-level marker
        // families and from the `done`-only Linked PR marker (the guard above), so
        // it co-renders with none of them.
        <Text wrap="truncate-end" color="yellow">
          {NEEDS_REVIEW_MARKER}
        </Text>
      )}
    </Box>
  );
}
