/**
 * The on-disk Issue `status` values the dispatch state machine reads and writes.
 * This is the single source of truth for the dispatch vocabulary so the
 * frontier (which reads them), the status-writer (which writes them), and the
 * orchestration (which transitions between them) can never disagree on a spelling
 * — a typo in one copy would land a card in Unsorted and silently strand the
 * Issue.
 *
 * Distinct from the board-lane vocabulary in {@link import("../model.js")}: those
 * are render columns; these are the authored statuses dispatch transitions an
 * Issue through.
 */
export const Status = {
  /** A spawn candidate: dispatch's frontier acts only on this status. */
  READY_FOR_AGENT: "ready-for-agent",
  /** Set synchronously when an Issue is dispatched, before its agent spawns. */
  IN_PROGRESS: "in-progress",
  /** Where an implementor agent leaves a finished Issue, awaiting a reviewer. */
  READY_FOR_REVIEW: "ready-for-review",
  /** Set when a reviewer picks up a ready-for-review Issue and starts reviewing. */
  IN_REVIEW: "in-review",
  /** The single human-attention queue: a review that an AI alone can't clear. */
  HUMAN_REVIEW: "human-review",
  /** A blocker only clears once the blocking Issue reaches this status. */
  DONE: "done",
} as const;

export type Status = (typeof Status)[keyof typeof Status];
