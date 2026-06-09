/**
 * The board model — a pure, immutable description of the PRDs (and, in later
 * slices, their Issues) found under the configured root. Produced by the
 * scanner from a filesystem path; consumed by the UI.
 *
 * Domain vocabulary follows CONTEXT.md: a PRD is a feature, an Issue is a unit
 * of work belonging to one PRD, and the authored statuses drive the kanban
 * columns.
 */

/** The canonical columns, left to right, that an authored status maps to. */
export type Column =
  | "backlog"
  | "ready"
  | "in-progress"
  | "ready-for-review"
  | "in-review"
  | "human-review"
  | "done";

/** Where a card lands. Missing/unknown authored status falls to "unsorted". */
export type Lane = Column | "unsorted";

/**
 * The lanes in render order, left to right: Unsorted first (so missing/unknown
 * status is never lost), then the seven fixed columns.
 */
export const LANES: readonly Lane[] = [
  "unsorted",
  "backlog",
  "ready",
  "in-progress",
  "ready-for-review",
  "in-review",
  "human-review",
  "done",
] as const;

/** Human-readable column headings, keyed by lane. */
export const LANE_LABELS: Readonly<Record<Lane, string>> = {
  unsorted: "Unsorted",
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  "ready-for-review": "Ready for Review",
  "in-review": "In Review",
  "human-review": "Human Review",
  done: "Done",
};

/**
 * The routing badge carried by a card while it is in the "ready" column,
 * derived from the compound `ready-for-*` authored status.
 */
export type ReadyFor = "human" | "agent";

/**
 * Why an Issue was escalated to `human-review`, recorded by the reviewer when it
 * takes the human-review exit (see reviewerPrompt). The three exits the reviewer
 * can take map one-to-one onto these: a recorded implementor deviation, a review
 * loop that did not converge within its cap, or a merge conflict. Surfaced as a
 * marker on the card so a human knows what attention it needs before opening it.
 */
export type HumanReviewReason = "deviation" | "non-convergence" | "conflict";

export interface Issue {
  /** Identity: the Issue filename (e.g. `001-auth.md`). */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the filename slug. */
  readonly title: string;
  /** The lane this Issue's card belongs in. */
  readonly lane: Lane;
  /** Set only when `lane === "ready"`; drives the human/agent badge. */
  readonly readyFor?: ReadyFor;
  /** Set only when `lane === "human-review"`; drives the escalation marker. */
  readonly humanReviewReason?: HumanReviewReason;
}

export interface PRD {
  /** Identity: the PRD directory name. */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the directory name. */
  readonly title: string;
  /** The lane this PRD's card belongs in. */
  readonly lane: Lane;
  /** Set only when `lane === "ready"`; drives the human/agent badge. */
  readonly readyFor?: ReadyFor;
  /**
   * The Issues belonging to this PRD, ordered by their `NNN-` filename prefix.
   * Every markdown file in the PRD directory other than `prd.md` is an Issue.
   */
  readonly issues: readonly Issue[];
}

export interface Board {
  readonly prds: readonly PRD[];
}
