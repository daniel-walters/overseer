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
 * place: the {@link Column}/{@link Lane} types, the render-order {@link ISSUE_LANES}
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
 * The Issue-level lanes in render order, left to right: Unsorted first (so
 * missing/unknown status is never lost), then the seven fixed columns. Used by
 * the PRD-zoom (Issue) kanban.
 */
export const ISSUE_LANES: readonly Lane[] = [
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
 * The board-level lanes in render order. A PRD has no stored status; its lane is
 * {@link derivePrdLane}-derived into just these three, so the top-level board
 * collapses to backlog / in-progress / done (ADR 0003). No Unsorted, ready, or
 * review columns — a PRD never lands there.
 */
export const BOARD_LANES = ["backlog", "in-progress", "done"] as const;

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

/**
 * Derive a PRD's board-level lane from its Issues (ADR 0003 — a PRD has no
 * stored status). The board level collapses to three lanes:
 *
 * - **done** — ≥ 1 Issue and every Issue is `done`.
 * - **in-progress** — any Issue is in-progress or later.
 * - **backlog** — otherwise (all backlog/ready/Unsorted, or zero Issues).
 *
 * An **Unsorted** Issue (missing/unknown status) counts as pre-in-progress: it
 * never promotes the PRD, and — not being `done` — blocks the all-done check, so
 * a `done` + `Unsorted` PRD derives to in-progress. An unknown-status Issue can
 * therefore never silently advance *or* complete a PRD.
 */
export function derivePrdLane(
  issues: readonly Issue[],
): "backlog" | "in-progress" | "done" {
  if (issues.length > 0 && issues.every((i) => i.lane === "done")) return "done";
  if (issues.some((i) => IN_PROGRESS_OR_LATER.has(i.lane))) return "in-progress";
  return "backlog";
}

/** The lanes that promote a PRD to in-progress (in-progress or later). */
const IN_PROGRESS_OR_LATER = new Set<Lane>([
  "in-progress",
  "ready-for-review",
  "in-review",
  "human-review",
  "done",
]);

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

/**
 * The liveness overlay on an Issue card: whether the agent Overseer spawned for
 * it is still in Claude's live session registry (CONTEXT.md, ADR 0008 / 0009).
 * Derived on each board open by joining the recorded `--bg` handles against
 * `claude agents --json`, and never written into the Issue files (ADR 0002, free
 * resume):
 *
 * - **live** — the Issue's handle is present in the registry.
 * - **orphaned** — the handle is gone *and* the registry query was trustworthy
 *   (a cleanly-parsed array), so the agent is genuinely dead on an active-lane
 *   card: stuck, recoverable (ADR 0009).
 * - **unknown** — every other case: the query was untrustworthy (a false
 *   `orphaned` would invite a double-spawn, ADR 0009), or no handle was recorded
 *   this session (a previous session, the spawn/record gap).
 *
 * The verdict never reads a false `live`; the scanner maps the probe's
 * trust-qualified absence onto this card-level type behind the active-lane gate.
 */
export type Liveness = "live" | "unknown" | "orphaned";

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
  /**
   * The derived liveness overlay, set only on an `in-progress` / `in-review`
   * card — `live` if its handle is in the registry, `orphaned` if a trustworthy
   * query shows the handle is gone, `unknown` otherwise. Absent on every other
   * lane (and when no lookup is wired in), so a never-dispatched card is distinct
   * from a dead one.
   */
  readonly liveness?: Liveness;
  /**
   * The suppressed overlay: `true` on an awaiting `ready-for-agent` /
   * `ready-for-review` card whose last spawn launch failed this session (the
   * failed-set reports `(path, edge)` suppressed). Set only on those two lanes
   * (the edge derived from the lane: `ready-for-agent → implementor`,
   * `ready-for-review → reviewer`), the
   * opposite set from {@link liveness}'s two active lanes — so the two overlays
   * are disjoint and can never co-render on one card. Absent on every other lane,
   * when no lookup is wired in, and when the lookup reports not-suppressed: a
   * read-only overlay, recomputed on each board open, never written to the Issue
   * file (ADR 0002). Lane-gating makes a lingering failed-set entry inert — an
   * Issue that leaves its `ready-*` lane simply drops the marker.
   */
  readonly suppressed?: boolean;
}

export interface PRD {
  /** Identity: the PRD directory name. */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the directory name. */
  readonly title: string;
  /**
   * The board-level lane this PRD's card belongs in: always one of backlog /
   * in-progress / done, {@link derivePrdLane}-derived from its Issues. A PRD is
   * never Unsorted, ready, or in a review lane, so it carries no `readyFor`.
   */
  readonly lane: "backlog" | "in-progress" | "done";
  /**
   * The Issues belonging to this PRD, ordered by their `NNN-` filename prefix.
   * Every markdown file in the PRD directory other than `prd.md` is an Issue.
   */
  readonly issues: readonly Issue[];
}

export interface Board {
  readonly prds: readonly PRD[];
}
