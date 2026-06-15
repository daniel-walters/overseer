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

/** The resolved review knobs: a pass cap and an effort level, both always present. */
export interface ReviewConfig {
  /** Hard cap on `/code-review` passes before the loop escalates to human-review. */
  readonly cap: number;
  /** The effort each `/code-review` pass runs at. */
  readonly effort: ReviewEffort;
}

/**
 * The current-behaviour defaults: cap 3 at medium effort (CONTEXT.md → Review
 * outcome). A config that omits the `[review]` knobs resolves to exactly these,
 * so existing boards are unchanged.
 */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  cap: 3,
  effort: "medium",
};
