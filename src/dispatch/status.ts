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
  /** Where an implementor agent leaves a finished Issue, awaiting an auditor. */
  READY_FOR_AUDIT: "ready-for-audit",
  /** Set when an auditor picks up a ready-for-audit Issue and starts auditing. */
  IN_AUDIT: "in-audit",
  /** Where an auditor leaves an audited Issue, awaiting a reviewer. */
  READY_FOR_REVIEW: "ready-for-review",
  /** Set when a reviewer picks up a ready-for-review Issue and starts reviewing. */
  IN_REVIEW: "in-review",
  /** The single human-attention queue: a review that an AI alone can't clear. */
  HUMAN_REVIEW: "human-review",
  /** A blocker only clears once the blocking Issue reaches this status. */
  DONE: "done",
} as const satisfies Record<string, AuthoredStatus>;

export type Status = (typeof Status)[keyof typeof Status];

/**
 * The active statuses — those an Overseer-spawned agent owns while it runs, where
 * the liveness overlay (and so Orphan detection, Kill, and Agent-output) belongs:
 * `in-progress` (implementor), `in-audit` (auditor), and `in-review` (reviewer).
 * Each is the active half of a spawn edge's awaiting→active pair, and each has an
 * awaiting target the orphan rollback writes (see rollback's AWAITING map).
 *
 * The waiting halves (`ready-for-agent`, `ready-for-audit`, `ready-for-review`)
 * are deliberately absent: no agent owns a waiting card, so it carries no liveness
 * — the distinction that, on the folded `audit` lane, separates a live/orphaned
 * `in-audit` card from a plain waiting `ready-for-audit` one (ADR 0026).
 */
export const ACTIVE_STATUSES: ReadonlySet<Status> = new Set<Status>([
  Status.IN_PROGRESS,
  Status.IN_AUDIT,
  Status.IN_REVIEW,
]);

/** Whether a frontmatter `status` value names an active (agent-owned) status. */
export function isActiveStatus(status: unknown): boolean {
  return (
    typeof status === "string" && (ACTIVE_STATUSES as ReadonlySet<string>).has(status)
  );
}
