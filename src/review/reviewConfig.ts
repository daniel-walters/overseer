/**
 * The tunable knobs for the AI-review loop (CONTEXT.md → Review outcome),
 * promoted out of the reviewer prompt so a board can tune how many `/code-review`
 * passes an Issue gets and at what effort without editing source. The reviewer
 * prompt reads these values rather than hardcoding literals, so the cap is a
 * single source of truth a later iteration-count marker can read off the same
 * config rather than a duplicated `3`.
 */

/**
 * The `/code-review` effort levels the reviewer loop can run at, trading
 * thoroughness against cost/latency. Mirrors the `/code-review` skill's own
 * effort vocabulary; the config validator rejects anything outside this set.
 */
export const REVIEW_EFFORTS = ["low", "medium", "high"] as const;

/** A `/code-review` effort level — one of {@link REVIEW_EFFORTS}. */
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/**
 * The grade axis of a Finding (CONTEXT.md → Severity): an ordered scale mirroring
 * the `/code-review` effort vocabulary. It grades *how much* a Finding matters
 * within its Category; on its own it does not decide whether a Finding blocks a
 * merge. The config validator rejects anything outside this set.
 *
 * Intentionally the same values as {@link REVIEW_EFFORTS} — Severity mirrors the
 * `/code-review` effort vocabulary by design (CONTEXT.md). Sharing the reference
 * keeps them in sync: a future extension to one automatically extends the other.
 */
export const SEVERITIES = REVIEW_EFFORTS;

/** A Finding Severity — one of {@link SEVERITIES}. Identical to {@link ReviewEffort} by design. */
export type Severity = ReviewEffort;

/**
 * The kind axis of a Finding (CONTEXT.md → Category): a non-overlapping taxonomy
 * of *what kind of issue it is*. Category **gates** tolerance — each carries its
 * own maximum tolerable Severity. The config validator rejects anything outside
 * this set.
 */
export const REVIEW_CATEGORIES = [
  "correctness",
  "security",
  "architecture",
  "style",
  "test",
  "docs",
] as const;

/** A Finding Category — one of {@link REVIEW_CATEGORIES}. */
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/**
 * A per-Category tolerance threshold: the maximum {@link Severity} that Category
 * will wave through, or `none` — the Category always blocks (identical to the
 * pre-tolerance "fix everything" behaviour). `none` is a valid threshold value.
 */
export type ToleranceLevel = Severity | "none";

/**
 * The resolved Tolerance policy (CONTEXT.md → Tolerance): every Category mapped to
 * its maximum tolerable Severity. A Finding is tolerable iff its Severity is within
 * its Category's threshold; `none` means nothing in that Category is tolerable. The
 * map is total — every {@link REVIEW_CATEGORIES} member is present after resolution.
 */
export type Tolerance = Readonly<Record<ReviewCategory, ToleranceLevel>>;

/** Returns true iff `value` is a valid {@link ToleranceLevel} (`none` or a {@link Severity}). */
export function isToleranceLevel(value: string): value is ToleranceLevel {
  return value === "none" || (SEVERITIES as readonly string[]).includes(value);
}

/** The resolved review knobs: a pass cap, an effort level, and a tolerance policy, all always present. */
export interface ReviewConfig {
  /** Hard cap on `/code-review` passes before the loop escalates to human-review. */
  readonly cap: number;
  /** The effort each `/code-review` pass runs at. */
  readonly effort: ReviewEffort;
  /**
   * The per-Category maximum-tolerable-Severity policy the reviewer prompt embeds
   * (ADR 0027). Overseer never reads it — the agent applies it during the pass to
   * decide which Findings block the merge. Always whole after resolution.
   */
  readonly tolerance: Tolerance;
}

/**
 * The current-behaviour defaults: cap 3 at medium effort (CONTEXT.md → Review
 * outcome). A config that omits the `[review]` knobs resolves to exactly these.
 *
 * The default tolerance is a deliberate, narrow break from "existing boards
 * unchanged" (ADR 0027): only `style` and `docs` are tolerable, each at `low`, so a
 * pure low-style-nit loop now merges instead of escalating; everything that matters
 * (`correctness`/`security`/`architecture`/`test`) stays `none` — always blocking,
 * byte-for-byte today's behaviour.
 */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  cap: 3,
  effort: "medium",
  tolerance: {
    correctness: "none",
    security: "none",
    architecture: "none",
    style: "low",
    test: "none",
    docs: "low",
  },
};
