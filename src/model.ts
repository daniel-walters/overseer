/**
 * The board model — a pure, immutable description of the PRDs (and, in later
 * slices, their Issues) found under the configured root. Produced by the
 * scanner from a filesystem path; consumed by the UI.
 *
 * Domain vocabulary follows CONTEXT.md: a PRD is a feature, an Issue is a unit
 * of work belonging to one PRD, and the authored statuses drive the kanban
 * columns.
 */

/**
 * The routing badge carried by a card while it is in the "ready" column,
 * derived from the compound `ready-for-*` authored status.
 */
export type ReadyFor = "human" | "agent";

/**
 * The single source of truth for the authored-status vocabulary: every `status`
 * string a card file may carry, mapped to the lane its card lands in and, for
 * the two `ready-for-*` values, the routing badge.
 *
 * Everything downstream is derived from this map so the vocabulary lives in one
 * place: the {@link Column}/{@link Lane} types, the render-order {@link LANES}
 * array, the {@link placeStatus} placement the scanner uses, and (by referencing
 * its keys) the dispatch state machine's write-vocabulary in
 * {@link import("./dispatch/status.js").Status}. A status added here flows to all
 * of them; a typo can't silently diverge one copy from another and strand a card
 * in Unsorted.
 *
 * Note the fold the map encodes: `ready-for-human` and `ready-for-agent` both
 * land in the single `ready` lane (distinguished only by the badge), so the
 * eight authored statuses collapse to seven columns.
 */
const STATUS_PLACEMENT = {
  backlog: { lane: "backlog" },
  "ready-for-human": { lane: "ready", readyFor: "human" },
  "ready-for-agent": { lane: "ready", readyFor: "agent" },
  "in-progress": { lane: "in-progress" },
  "ready-for-review": { lane: "ready-for-review" },
  "in-review": { lane: "in-review" },
  "human-review": { lane: "human-review" },
  done: { lane: "done" },
} as const satisfies Record<string, { lane: string; readyFor?: ReadyFor }>;

/**
 * Every authored `status` string a card file may carry. The dispatch state
 * machine ({@link import("./dispatch/status.js").Status}) names the subset it
 * transitions through; this is the full set the scanner recognises.
 */
export type AuthoredStatus = keyof typeof STATUS_PLACEMENT;

/** The canonical columns, left to right, that an authored status maps to. */
export type Column = (typeof STATUS_PLACEMENT)[AuthoredStatus]["lane"];

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

/**
 * Map an authored status string to its lane and, while ready, its routing badge,
 * or `undefined` when the status is missing or not a recognised authored value.
 * The scanner maps that `undefined` to the `unsorted` lane — its fail-safe so a
 * card is never dropped. Derived from {@link STATUS_PLACEMENT} so the lane rules
 * are never restated as a parallel switch.
 */
export function placeStatus(
  status: unknown,
): { readonly lane: Lane; readonly readyFor?: ReadyFor } | undefined {
  if (typeof status !== "string") return undefined;
  // Own-property check, not a bare index: a `status` that names an
  // `Object.prototype` member (`toString`, `constructor`, `__proto__`, …) would
  // otherwise read the inherited function off the literal and return it as a
  // bogus placement — bypassing the unsorted fail-safe and crashing the lane
  // grouping with a `lane: undefined` card.
  if (!Object.hasOwn(STATUS_PLACEMENT, status)) return undefined;
  return STATUS_PLACEMENT[status as AuthoredStatus];
}

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
 * The vocabulary of human-review escalation reasons, in one place. The reviewer
 * prompt's instructions, the scanner's frontmatter parser, and the
 * {@link HumanReviewReason} type are all derived from this single tuple so a
 * renamed or added reason can't silently drift between them — a mismatch would
 * make the reviewer write a token the scanner drops, leaving the card with no
 * marker and the escalation looking reason-less.
 */
export const HUMAN_REVIEW_REASONS = [
  "deviation",
  "non-convergence",
  "conflict",
] as const;

/**
 * Why an Issue was escalated to `human-review`, recorded by the reviewer when it
 * takes the human-review exit (see reviewerPrompt). The three exits the reviewer
 * can take map one-to-one onto these: a recorded implementor deviation, a review
 * loop that did not converge within its cap, or a merge conflict. Surfaced as a
 * marker on the card so a human knows what attention it needs before opening it.
 */
export type HumanReviewReason = (typeof HUMAN_REVIEW_REASONS)[number];

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
