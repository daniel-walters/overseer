import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor, HumanReviewReason, Liveness, LinkedPr } from "../model.js";
import { REASON_MARKER } from "../model.js";

interface CardProps {
  title: string;
  /**
   * The card's identity — an Issue filename (`007-session-tokens.md`) or a PRD
   * directory name (`auth-system`). Only its leading `NNN` sort prefix is
   * surfaced, as the dim id line under the title (see {@link taskNumber}); a PRD
   * dir name has no such prefix, so a PRD card renders no id line. Optional so
   * the prop is additive — a card handed no id (older callers, tests) is unchanged.
   */
  id?: string;
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
   * Suppressed marker, present on an awaiting `ready-for-agent` /
   * `ready-for-review` card whose last spawn launch failed this session, or an
   * `in-review` card whose clean merge hit a transient failure (CONTEXT.md, ADR
   * 0011 / 0019). On the `ready-*` lanes it is disjoint from {@link liveness}; on
   * `in-review` it can co-occur with both {@link liveness} and {@link reviewPass}
   * (a held merge on a card whose reviewer has exited), so this marker **outranks**
   * them — every other Issue-level marker below is gated `&& !suppressed`.
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
  /**
   * The currently-running AI-review pass for a live `in-review` card (the Reviewer
   * Iteration Count PRD, ADR 0018): the `reviewPass` Overseer recorded in the
   * sidecar, surfaced together with {@link reviewCap} as a neutral `N/cap` marker.
   * `1` the moment review begins, ticking up per pass. Absent on every card that is
   * not a live in-review pass — so an Orphaned in-review card (whose Orphan marker
   * wins) and an Issue off the in-review lane carry no count, and a missing pass
   * never renders a false `0/cap`. Joined onto the card by the scanner behind the
   * live-and-in-review gate; the Card only renders what it is handed.
   */
  reviewPass?: number;
  /**
   * The configured AI-review cap (`config.review.cap`) — the denominator of the
   * `N/cap` marker, and the very value the Reactor's cap check reads (one source of
   * truth). A board-wide constant threaded down from config, not a per-card field;
   * the marker renders only when both it and {@link reviewPass} are present.
   */
  reviewCap?: number;
  /**
   * Stalled marker, present on a PRD card with unblocked `ready-for-agent` work
   * waiting and nothing in flight (CONTEXT.md;
   * {@link import("../model.js").derivePrdStalled}). The second Issue→PRD roll-up,
   * a sibling to {@link needsReview} — it tells the board "this PRD has
   * dispatchable work but nobody's coming for it" without zooming. Rendered only
   * when {@link autoRunOff} is also set: auto-run *on* means the Reactor is coming
   * for the work, so the "nobody's coming" framing only holds when the brake is on.
   * A PRD-level marker, disjoint from the Issue-level markers and (like
   * needs-review) from the `done`-only Linked PR marker.
   */
  stalled?: boolean;
  /**
   * Whether the global auto-run brake is **off** (the Reactor is not auto-spawning)
   * — a board-wide session flag threaded down from {@link import("./App.js")}, not a
   * per-card field. It gates the {@link stalled} marker: a stalled PRD only reads as
   * "nobody's coming" when nothing is coming, i.e. auto-run is off.
   */
  autoRunOff?: boolean;
  /** Whether this card is the current selection. */
  selected?: boolean;
}

const BADGE: Record<ReadyFor, string> = {
  human: "🧑",
  agent: "🤖",
};

/**
 * The task number Overseer refers to an Issue by — the leading `NNN` sort prefix
 * of its filename (`007-session-tokens.md` ⇒ `007`), padding preserved so the id
 * reads exactly as it does in conversation and in `blocked_by` references. Returns
 * `undefined` when the id has no numeric prefix — a PRD carries a directory-name
 * id (`auth-system`), so a PRD card surfaces no number and renders no id line.
 */
function taskNumber(id: string | undefined): string | undefined {
  return id?.match(/^\d+/)?.[0];
}

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
 * Resolve a `done` PRD's {@link LinkedPr} to its card marker (text + color),
 * collapsing the single-PR and stacked cases into one line. A **stacked** overlay
 * (ADR 0025) reads as an aggregate `N/M merged` count instead of the three-state
 * word: green once the whole stack has landed (N = M — the `merged` headline,
 * mirroring a single merged PR's "good, done" green), else cyan while any slice is
 * still unmerged (the in-progress reading, mirroring a single open PR's neutral
 * cyan). A **single-PR** overlay (no `stack`) keeps exactly the three-state
 * {@link LINKED_PR_MARKER} — the M = 1 collapse, byte-identical to today.
 */
function linkedPrMarker(linkedPr: LinkedPr): { text: string; color: string } {
  if (linkedPr.stack) {
    const { merged, total } = linkedPr.stack;
    return {
      text: `${merged}/${total} merged`,
      color: linkedPr.state === "merged" ? "green" : "cyan",
    };
  }
  return LINKED_PR_MARKER[linkedPr.state];
}

/**
 * The needs-review marker on a PRD card with ≥1 Issue in `human-review`, following
 * the same own-line truncating idiom as the other markers (CONTEXT.md). Yellow and
 * `⚠` place it in the "needs a human" warning family — the same family as the
 * human-review reason markers it rolls up — so the board reads it as "blocked on
 * you". A PRD-level marker, disjoint from the Issue-level marker families and from
 * the `done`-only Linked PR marker, so it co-renders with none of them.
 */
const NEEDS_REVIEW_MARKER = "⚠ needs review";

/**
 * The stalled marker on a PRD card with unblocked agent work waiting and nothing
 * in flight while auto-run is off (CONTEXT.md; derivePrdStalled). Deliberately
 * *cyan/neutral* with `◌` (an empty-circle "nothing running"), set apart from the
 * yellow `⚠` "needs a human" family (orphan, needs-review, bad-status) and the red
 * `⊘` "nothing-ran-and-failed" suppressed marker: stalled is not a warning or a
 * failure — it is a healthy queue waiting on a keypress (`d`/resume). Its own
 * own-line truncating idiom, like every other marker.
 */
const STALLED_MARKER = "◌ stalled";

/** The colour of the neutral stalled marker — distinct from the warning family. */
const STALLED_COLOR = "cyan";

/**
 * The glyph leading the review-pass `N/cap` marker (the Reviewer Iteration Count
 * PRD, ADR 0018). Deliberately **neutral**: `◷` (a partial-clock "in progress")
 * reads apart from the yellow "needs a human" warning family (`⚠ orphaned`,
 * `⚠ deviation`, `↻ non-convergence`, `✗ conflict`, `⚠ bad status`) and the red
 * `⊘ suppressed` "nothing ran" family, because this is the *healthy in-progress*
 * path — a card actively moving through review, not a warning. Rendered in a
 * neutral colour ({@link REVIEW_PASS_COLOR}) for the same reason; the marker reads
 * `◷ N/cap`, the count composed from the two props the scanner and config supply.
 */
const REVIEW_PASS_GLYPH = "◷";

/**
 * The neutral colour of the review-pass marker — outside the yellow warning family
 * and the red suppressed family. `cyan` is the board's other neutral "there's
 * something here, not an alarm" colour (a `done` PRD's open-PR marker), so it
 * reads as the healthy in-progress signal the PRD asks
 * for, never an escalation cue. (Tests assert the family by glyph, since the test
 * renderer strips ANSI; the colour is the on-screen reinforcement.)
 */
const REVIEW_PASS_COLOR = "cyan";

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({
  title,
  id,
  readyFor,
  humanReviewReason,
  liveness,
  suppressed,
  malformedStatus,
  linkedPr,
  needsReview,
  reviewPass,
  reviewCap,
  stalled,
  autoRunOff,
  selected = false,
}: CardProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      // Selection is magenta, not cyan: cyan already marks an open Linked PR
      // (LINKED_PR_MARKER.open) and the neutral review-pass count, so on a done
      // PRD with an open PR the old cyan border and the marker shared a colour and
      // muddied the cue. Magenta is otherwise unused on the board, so the selected
      // card's outline never collides with a status colour (issue #75).
      borderColor={selected ? "magenta" : undefined}
      paddingX={1}
      width="100%"
    >
      <Text wrap="truncate-end" bold={selected} inverse={selected}>
        {/* A bold inverse bar is the second selection cue (issue #75): the border
            colour alone was easy to miss on a busy board. It rides the existing
            title line — inverse and bold are pure styling, so they add no
            character and never re-eat the title width the `▶ ` arrow once cost
            (commit 8cea476). Scoped to the title only, so the coloured marker
            lines below stay legible and selection never fights status. */}
        {readyFor ? `${BADGE[readyFor]} ` : ""}
        {title}
      </Text>
      {taskNumber(id) && (
        // The task number on its own dim line directly under the title — the id
        // Overseer refers to the Issue by (`007`), so a card can be named aloud
        // without zooming. Dim and prefixed `#` keeps it clearly secondary
        // metadata, never mistaken for the coloured status markers below; it
        // truncates like every other line so a narrow card never overflows. Only
        // rendered when the id carries a numeric prefix, so a PRD card (whose id
        // is a directory name) shows no line.
        <Text wrap="truncate-end" dimColor>
          {`#${taskNumber(id)}`}
        </Text>
      )}
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
        // title, so the overlay never displaces the card's identity. The
        // `!suppressed` guard is load-bearing on `in-review`: a held clean merge
        // (ADR 0019) sits on a card whose reviewer has exited (orphaned/unknown
        // liveness), and the suppressed marker outranks that — the card reads as a
        // held merge to reopen, not an Orphan to recover with `R`.
        <Text wrap="truncate-end" color={LIVENESS_MARKER[liveness].color}>
          {LIVENESS_MARKER[liveness].text}
        </Text>
      )}
      {suppressed && (
        // Its own truncating line, red — a launch-failed card (`ready-*`) or a
        // held clean merge (`in-review`, ADR 0019) parked this session. On
        // `in-review` it deliberately outranks the liveness and `N/cap` markers
        // (the `&& !suppressed` guards above and below), so a held merge is never
        // masked (ADR 0011).
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
        // co-renders with none of them; cyan for open, green for merged (ADR 0013),
        // or the aggregate `N/M merged` count for a stacked PRD (ADR 0025) —
        // {@link linkedPrMarker} resolves which.
        // The `!needsReview` guard is the last line of defence between the two
        // PRD-level markers: their lanes are disjoint (Linked PR is `done`-only,
        // needs-review implies not-`done`), so the scanner never co-sets them, but
        // even handed both the card reads as one coherent state — needs-review wins.
        <Text wrap="truncate-end" color={linkedPrMarker(linkedPr).color}>
          {linkedPrMarker(linkedPr).text}
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
      {stalled && autoRunOff && (
        // Its own truncating line, neutral cyan — a PRD with unblocked agent work
        // waiting and nothing in flight, rolled up so the board reads "nobody's
        // coming" without zooming (CONTEXT.md, derivePrdStalled). The `autoRunOff`
        // gate is load-bearing: with auto-run on the Reactor *is* coming, so the
        // marker would lie. A PRD-level marker disjoint from the Issue-level
        // families; mutually exclusive with needsReview (a stalled PRD has nothing
        // in flight, needs-review implies a human-review Issue), so the two never
        // co-render even though neither guards the other.
        <Text wrap="truncate-end" color={STALLED_COLOR}>
          {STALLED_MARKER}
        </Text>
      )}
      {reviewPass !== undefined && reviewCap !== undefined && !suppressed && (
        // Its own truncating line, neutral cyan — the `N/cap` review-pass marker on
        // a live in-review card (ADR 0018). The scanner gates this to a *live*
        // in-review Issue, so an Orphan (whose loud liveness marker renders above)
        // and any off-lane card never carry the count; the `reviewPass !== undefined`
        // guard also means a card with no recorded pass shows no false `0/cap`. The
        // `!suppressed` guard is load-bearing now that both ride the `in-review`
        // lane: a held clean merge (ADR 0019) outranks the neutral count, so the
        // card reads as a held merge, never masked by the healthy in-progress signal.
        <Text wrap="truncate-end" color={REVIEW_PASS_COLOR}>
          {`${REVIEW_PASS_GLYPH} ${reviewPass}/${reviewCap}`}
        </Text>
      )}
    </Box>
  );
}
