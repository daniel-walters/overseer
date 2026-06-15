import type { AuthoredStatus } from "../model.js";

/**
 * The on-disk Issue `status` values the dispatch state machine reads and writes.
 * This is the single source of truth for the dispatch vocabulary so the
 * frontier (which reads them), the status-writer (which writes them), and the
 * orchestration (which transitions between them) can never disagree on a spelling
 * — a typo in one copy would land a card in backlog flagged `malformedStatus`
 * and silently strand the Issue.
 *
 * A *named subset* of the full authored vocabulary in {@link import("../model.js")}:
 * those values are the render columns and the complete set of statuses a card may
 * carry; these are the ones dispatch actively transitions an Issue *through*
 * (`ready-for-human` and plain `backlog` are authored but never written by
 * dispatch). The `satisfies AuthoredStatus` constraint makes that subset
 * relationship load-bearing: a value here that is not a real authored status is a
 * compile error, so the two vocabularies cannot drift apart.
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
} as const satisfies Record<string, AuthoredStatus>;

export type Status = (typeof Status)[keyof typeof Status];
