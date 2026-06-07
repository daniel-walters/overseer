/**
 * The board model — a pure, immutable description of the PRDs (and, in later
 * slices, their Issues) found under the configured root. Produced by the
 * scanner from a filesystem path; consumed by the UI.
 *
 * Domain vocabulary follows CONTEXT.md: a PRD is a feature, an Issue is a unit
 * of work belonging to one PRD, and the five statuses drive the kanban columns.
 */

/** The five canonical columns, left to right, that an authored status maps to. */
export type Column = "backlog" | "ready" | "in-progress" | "in-review" | "done";

/** Where a card lands. Missing/unknown authored status falls to "unsorted". */
export type Lane = Column | "unsorted";

/** The columns in render order, left to right (Unsorted is rendered before these). */
export const COLUMNS: readonly Column[] = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "done",
] as const;

/**
 * The routing badge carried by a card while it is in the "ready" column,
 * derived from the compound `ready-for-*` authored status.
 */
export type ReadyFor = "human" | "agent";

export interface PRD {
  /** Identity: the PRD directory name. */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the directory name. */
  readonly title: string;
  /** The lane this PRD's card belongs in. */
  readonly lane: Lane;
  /** Set only when `lane === "ready"`; drives the human/agent badge. */
  readonly readyFor?: ReadyFor;
}

export interface Board {
  readonly prds: readonly PRD[];
}
