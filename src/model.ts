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
 * place: the {@link Lane} type, the render-order {@link ISSUE_LANES}
 * array, the {@link placeStatus} placement the scanner uses, and (by referencing
 * its keys) the dispatch state machine's write-vocabulary in
 * {@link import("./dispatch/status.js").Status}. A status added here flows to all
 * of them; a typo can't silently diverge one copy from another and strand a card
 * in backlog flagged `malformedStatus`.
 *
 * Note the two folds the map encodes: `ready-for-human` and `ready-for-agent`
 * both land in the single `ready` lane (distinguished only by the badge), and
 * `ready-for-audit` (awaiting) and `in-audit` (active) both land in the single
 * `audit` lane — the active/waiting distinction carried by the liveness overlay,
 * not a column each (ADR 0026). So the ten authored statuses collapse to eight
 * columns.
 */
const STATUS_PLACEMENT = {
  backlog: { lane: "backlog" },
  "ready-for-human": { lane: "ready", readyFor: "human" },
  "ready-for-agent": { lane: "ready", readyFor: "agent" },
  "in-progress": { lane: "in-progress" },
  "ready-for-audit": { lane: "audit" },
  "in-audit": { lane: "audit" },
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

/**
 * Where a card lands — one of the canonical columns an authored status maps to.
 * A missing/unrecognised status no longer gets its own lane: the scanner folds
 * it into `backlog` carrying a `malformedStatus` flag (so it stays one fewer
 * column while the data error is still flagged on the card), so every lane is a
 * real column.
 */
export type Lane = (typeof STATUS_PLACEMENT)[AuthoredStatus]["lane"];

/**
 * The Issue-level lanes in render order, left to right: the eight fixed columns.
 * There is no Unsorted column — a missing/unknown status folds into `backlog`
 * flagged `malformedStatus` (CONTEXT.md, ADR 0003). The `audit` column sits
 * between `in-progress` and `ready-for-review`, folding the awaiting
 * `ready-for-audit` and active `in-audit` statuses (ADR 0026). Used by the
 * PRD-zoom (Issue) kanban.
 */
export const ISSUE_LANES: readonly Lane[] = [
  "backlog",
  "ready",
  "in-progress",
  "audit",
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
 * The scanner folds that `undefined` into the `backlog` lane flagged
 * `malformedStatus` — its fail-safe so a card is never dropped. Derived from
 * {@link STATUS_PLACEMENT} so the lane rules are never restated as a parallel
 * switch.
 */
export function placeStatus(
  status: unknown,
): { readonly lane: Lane; readonly readyFor?: ReadyFor } | undefined {
  if (typeof status !== "string") return undefined;
  // Own-property check, not a bare index: a `status` that names an
  // `Object.prototype` member (`toString`, `constructor`, `__proto__`, …) would
  // otherwise read the inherited function off the literal and return it as a
  // bogus placement — bypassing the backlog/malformed fail-safe and crashing the
  // lane grouping with a `lane: undefined` card.
  if (!Object.hasOwn(STATUS_PLACEMENT, status)) return undefined;
  return STATUS_PLACEMENT[status as AuthoredStatus];
}

/**
 * Derive a PRD's board-level lane from its Issues (ADR 0003 — a PRD has no
 * stored status). The board level collapses to three lanes:
 *
 * - **done** — ≥ 1 Issue and every Issue is `done`.
 * - **in-progress** — any Issue is in-progress or later.
 * - **backlog** — otherwise (all backlog/ready, or zero Issues).
 *
 * A **malformed-status** Issue (missing/unknown status) folds into the backlog
 * lane (carrying `malformedStatus`), so it counts as pre-in-progress: it never
 * promotes the PRD, and — its lane not being `done` — blocks the all-done check,
 * so a `done` + malformed PRD derives to in-progress. An unknown-status Issue can
 * therefore never silently advance *or* complete a PRD — exactly as the retired
 * `unsorted` lane behaved.
 */
export function derivePrdLane(
  issues: readonly Issue[],
): "backlog" | "in-progress" | "done" {
  if (issues.length > 0 && issues.every((i) => i.lane === "done")) return "done";
  if (issues.some((i) => IN_PROGRESS_OR_LATER.has(i.lane))) return "in-progress";
  return "backlog";
}

/**
 * Derive a PRD's board-level **needs-review** overlay from its Issues: `true`
 * iff ≥1 Issue is parked in `human-review` — the one pipeline lane genuinely
 * *blocked on a human* — and `false` otherwise (including an empty PRD). It
 * rolls an Issue-level fact up to the PRD card so the board answers "which PRDs
 * are blocked on me?" without zooming.
 *
 * Like {@link derivePrdLane} it is a pure, side-effect-free derivation over the
 * Issues, recomputed each scan and never written to `prd.md` (ADR 0002 / 0003).
 * It is **presence-only** (no count) and **reason-agnostic** — any escalation
 * reason counts, since `human-review` is the signal, not why. Deliberately
 * scoped to `human-review` only, not the broader needs-a-human set
 * (`ready-for-human`, orphan, malformed-status, suppressed).
 */
export function derivePrdNeedsReview(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.lane === "human-review");
}

/**
 * Derive a PRD's board-level **stalled** overlay: `true` iff the PRD has agent
 * work that nobody is coming for — ≥1 unblocked `ready-for-agent` Issue (all its
 * `blocked_by` blockers are `done`) **and** no Issue in the audit lane or actively
 * running (`in-progress` / audit-lane / `in-review`). The `audit` lane suppresses
 * the flag for both `in-audit` (agent running) and `ready-for-audit` (pending
 * handoff): work already queued in the audit phase means the pipeline is making
 * progress, so the PRD is not stalled. It answers "this PRD has dispatchable work but
 * nothing is running and nothing is queued downstream" so the board can flag it.
 *
 * Pure and presence-only like {@link derivePrdNeedsReview} / {@link derivePrdLane},
 * recomputed each scan and never written to `prd.md` (ADR 0002 / 0003). It reads
 * only the on-disk Issues; whether the marker actually *renders* additionally
 * depends on **auto-run being off** (session Reactor state the scanner can't see),
 * so that gate is applied at render time, not here — auto-run *on* means the
 * Reactor is coming for this work, so "nobody's coming" only holds when it's off.
 */
export function derivePrdStalled(issues: readonly Issue[]): boolean {
  const inFlight = issues.some(
    (i) => i.lane === "in-progress" || i.lane === "audit" || i.lane === "in-review",
  );
  if (inFlight) return false;
  const doneIds = new Set(issues.filter((i) => i.lane === "done").map((i) => i.id));
  return issues.some(
    (i) =>
      i.lane === "ready" &&
      i.readyFor === "agent" &&
      (i.blockedBy ?? []).every((id) => doneIds.has(id)),
  );
}

/**
 * Derive a PRD's board-level **tolerated** overlay: `true` iff ≥1 of its Issues
 * carries the {@link Issue.tolerated} marker — a `done` Issue that merged with
 * tolerated findings waved through (review-tolerance PRD, ADR 0027). It rolls the
 * Issue-level fact up to the PRD card so the board answers "which PRDs carried
 * tolerated findings?" without zooming.
 *
 * Because {@link Issue.tolerated} is set only on a `done` Issue carrying a
 * non-blank `review_tolerated`, the done-lane gate lives at the Issue level and
 * this roll-up simply observes it — a `human-review` Issue carrying the field
 * (audit trail there) never sets `tolerated`, so it can't promote the PRD marker.
 *
 * Pure and presence-only like {@link derivePrdNeedsReview} / {@link derivePrdStalled},
 * recomputed each scan and never written to `prd.md` (ADR 0002 / 0003). Purely
 * **informational** — unlike needs-review it is never a call to action, so it is
 * not gated on any session state and co-renders freely with the other markers.
 */
export function derivePrdTolerated(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.tolerated);
}

/** The lanes that promote a PRD to in-progress (in-progress or later). */
const IN_PROGRESS_OR_LATER = new Set<Lane>([
  "in-progress",
  "audit",
  "ready-for-review",
  "in-review",
  "human-review",
  "done",
]);

/** Human-readable column headings, keyed by lane. */
export const LANE_LABELS: Readonly<Record<Lane, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  audit: "Audit",
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
 * The sole `review_verdict` value (ADR 0019): a review pass found zero findings.
 * The pass agent writes it to the Issue frontmatter and leaves `status:
 * in-review`; Overseer reads it to know the clean merge → `done` resolve may run.
 * It is the one bit Overseer cannot derive — `deviation`, `conflict`, and
 * `non-convergence` it already has from elsewhere — so `clean` is the only value.
 */
export const REVIEW_VERDICT_CLEAN = "clean";

/**
 * Why an Issue was escalated to `human-review`, recorded by the reviewer when it
 * takes the human-review exit (see reviewerPrompt). The three exits the reviewer
 * can take map one-to-one onto these: a recorded implementor deviation, a review
 * loop that did not converge within its cap, or a merge conflict. Surfaced as a
 * marker on the card so a human knows what attention it needs before opening it.
 */
export type HumanReviewReason = (typeof HUMAN_REVIEW_REASONS)[number];

/**
 * The user-facing escalation marker for each reason: a glyph for at-a-glance
 * scanning plus the reason word. Lives here beside {@link HumanReviewReason}
 * rather than in a component because two presentation surfaces share it — the
 * card's terse marker (`Card.tsx`) and the detail view's header heading
 * (`markdown.ts`) — and the text/markdown module must not depend on the React
 * component to read it (that would drag Ink into the markdown layer). Kept short
 * because the card line truncates; the marker is the attention signal that earns
 * its place ahead of the title.
 */
export const REASON_MARKER: Record<HumanReviewReason, string> = {
  deviation: "⚠ deviation",
  "non-convergence": "↻ non-convergence",
  conflict: "✗ conflict",
};

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

/**
 * The Linked PR overlay on a `done` PRD card: whether it has a GitHub PR for its
 * derived feature branch, and that PR's state (CONTEXT.md, ADR 0013). Derived on
 * each scan by a live `gh` query, joined onto the PRD at overlay time, and never
 * written to a sidecar or `prd.md` (ADR 0002 / 0003) — so a PR opened, merged, or
 * closed *outside* Overseer is reflected on the next scan, and the merged state
 * (the real end-of-lifecycle signal that the out-of-scope default-branch merge
 * happened) stays honest.
 *
 * Three-state, with *no PR* being the overlay's **absence** (no marker): only an
 * *open* and a *merged* PR carry a value. A closed-unmerged PR folds into *no PR*
 * (the marker disappears), so it is deliberately not a fourth state. The `url` is
 * what the `go to PR` keybind opens. Opening/merging a PR never changes the PRD's
 * derived lane (ADR 0003) — this is a pure overlay.
 *
 * When the PRD opened a **stack** (its Issues carried ≥2 distinct `slice:` values,
 * so Open PR materialized a chain of slice PRs — CONTEXT.md → Stacked output, ADR
 * 0025), the overlay rolls all the slice PRs' states into the {@link stack}
 * aggregate. There is no single PR then: `state` carries the aggregate's headline
 * (`merged` only when the whole stack has landed — N = M; `open` while any slice
 * is still unmerged — 0 ≤ N < M, the *in-progress* reading), and `url` points at
 * the **bottom** PR (slice 1, the stack's entry point a human merges first and
 * `go to PR` opens). The single-PR case is exactly the M = 1 collapse of this
 * aggregate, and there {@link stack} is absent — the marker reads as today's plain
 * three states, no count.
 */
export interface LinkedPr {
  readonly state: "open" | "merged";
  readonly url: string;
  /**
   * The stack roll-up, present **only** when the PRD opened a stack of ≥2 slice
   * PRs (M ≥ 2): `merged` of `total` slice PRs have landed. The card renders it as
   * an `N/M merged` signal instead of the plain three-state marker, and the PRD
   * reads as fully landed only at `merged === total` — any `merged < total` is the
   * *in-progress* reading even though every Issue (and so the PRD's lane) is
   * `done`. Absent for the single-PR (M = 1) case, which keeps exactly today's
   * three-state marker.
   */
  readonly stack?: { readonly merged: number; readonly total: number };
}

export interface Issue {
  /** Identity: the Issue filename (e.g. `001-auth.md`). */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the filename slug. */
  readonly title: string;
  /** The lane this Issue's card belongs in. */
  readonly lane: Lane;
  /** Set only when `lane === "ready"`; drives the human/agent badge. */
  readonly readyFor?: ReadyFor;
  /**
   * The Issue ids this Issue is `blocked_by` (authored frontmatter), empty when
   * unblocked. Carried on the model Issue (not just the dispatch reader) so the
   * board can derive the {@link derivePrdStalled} roll-up — "unblocked agent work
   * is waiting" — without reaching into the dispatch layer. Read straight from the
   * file each scan; a blocker is cleared when its Issue is `done`.
   */
  readonly blockedBy?: readonly string[];
  /** Set only when `lane === "human-review"`; drives the escalation marker. */
  readonly humanReviewReason?: HumanReviewReason;
  /**
   * The reviewer's free-text explanation of *why* this Issue needs human
   * attention, written at the human-review exit for all three escalation reasons
   * (for a deviation, it folds in the implementor's own `deviation` note). Set
   * only when `lane === "human-review"` and the frontmatter carries a non-blank
   * `human_review_note`; absent otherwise — additive to and independent of
   * {@link humanReviewReason} (the enum that drives the card marker). The detail
   * view renders it beneath the reason; the card stays terse.
   */
  readonly humanReviewNote?: string;
  /**
   * The Approve eligibility overlay (PRD: Approve from Board, ADR 0021): `true` on
   * a `human-review` card that carries a recorded `worktree` **and** `branch` in its
   * frontmatter — the merge handoff the `A` keybind needs. **Reason-agnostic**: it
   * never reads {@link humanReviewReason}, so a hand-fixed `conflict`/`non-convergence`
   * Issue (whose reason is an audit trail Overseer never rewrites) is still approvable
   * — the merge preflight, not the reason, is the real gate.
   *
   * Set only on `lane === "human-review"`; absent on every other lane and on a
   * human-review card missing the handoff, so a card that can't be merged from the
   * board carries no Approve affordance. A derived overlay recomputed on each board
   * open, never written to the Issue file (ADR 0002) — like {@link humanReviewReason},
   * it rides its own lane so a stale handoff can't light `A` on a moved card.
   */
  readonly approvable?: boolean;
  /**
   * The derived liveness overlay, set only on an active-agent card
   * (`in-progress` / `in-audit` / `in-review`) — `live` if its handle is in the
   * registry, `orphaned` if a trustworthy query shows the handle is gone, `unknown`
   * otherwise. Absent on every other status (and when no lookup is wired in), so a
   * never-dispatched card is distinct from a dead one. The gate is per-status, not
   * per-lane: the `audit` lane folds `in-audit` (active, carries liveness) and
   * `ready-for-audit` (waiting, no liveness) — the overlay is the signal that
   * distinguishes them on the shared column (ADR 0026).
   */
  readonly liveness?: Liveness;
  /**
   * The suppressed overlay: `true` on an awaiting `ready-for-agent` /
   * `ready-for-review` card whose last spawn launch failed this session, or an
   * `in-review` card whose clean merge hit a transient failure (the failed-set
   * reports `(path, edge)` suppressed). The edge is derived from the lane:
   * `ready-for-agent → implementor`, `ready-for-review → reviewer`,
   * `in-review → resolve` (the non-spawn merge edge — ADR 0019). On the two
   * `ready-*` lanes it is the mirror image of {@link liveness} (the active lanes),
   * but on `in-review` it overlaps liveness — a held merge can sit on a card whose
   * dead reviewer also reads `orphaned` — so the two are *not* always disjoint;
   * when both are present the suppressed marker outranks liveness on the card
   * (Card precedence), mirroring how the Orphan marker outranks the `N/cap` count.
   * Absent on every other lane, when no lookup is wired in, and when the lookup
   * reports not-suppressed: a read-only overlay, recomputed on each board open,
   * never written to the Issue file (ADR 0002). Lane-gating makes a lingering
   * failed-set entry inert — an Issue that leaves its suppressible lane simply
   * drops the marker.
   */
  readonly suppressed?: boolean;
  /**
   * `true` on an Issue whose authored `status` is missing or unrecognised. Such
   * an Issue folds into the **backlog** lane (so PRD-status derivation treats it
   * as pre-in-progress exactly as the retired `unsorted` lane did), but carries
   * this overlay so its card flags a loud warning marker — the status is a *data
   * error to fix in the frontmatter*, not deliberate backlog parking. Kept in the
   * yellow "needs a human" warning family (like {@link humanReviewReason} and an
   * orphaned {@link liveness}), distinct from a plain backlog card and from the
   * red {@link suppressed} "nothing ran" marker. Absent on every Issue with a
   * recognised status.
   */
  readonly malformedStatus?: boolean;
  /**
   * The currently-running AI-review pass for this Issue (the Reviewer Iteration
   * Count PRD, ADR 0018): the `reviewPass` Overseer recorded in the sidecar per
   * spawn, surfaced on the card as a neutral `N/cap` marker (the cap from
   * `config.review.cap`). `1` the instant review begins, ticking up per pass.
   *
   * Set **only on a *live* `in-review` card** — the read side joins the sidecar
   * count onto the Issue behind the same liveness verdict the marker is gated by,
   * so it is the join's analogue of {@link liveness}. Deliberately absent when the
   * in-review agent is an Orphan (the Orphan {@link liveness} marker wins — a dead
   * agent is not "on pass 2" of anything), when the Issue has left the in-review
   * lane (converged to `done`, escalated to `human-review`), and when no pass was
   * recorded (no false `0/cap` from a default — absent ≠ `0`). A derived overlay
   * recomputed on each board open, never written to the Issue file (ADR 0002).
   */
  readonly reviewPass?: number;
  /**
   * `true` on a **`done`** Issue whose frontmatter carries a non-blank
   * `review_tolerated` — a clean-with-tolerated merge that waved tolerable
   * findings through (review-tolerance PRD, ADR 0027), surfaced as the neutral
   * "merged with tolerated findings" card marker (the `◌ stalled` family — cyan,
   * informational, never a call to action). **Gated on the `done` lane**: the same
   * field on a `human-review` Issue (a deviating Issue whose review converged
   * clean-with-tolerated) is audit trail there, not a marker, so this is unset on
   * every non-`done` card. Read straight from the Issue file each scan (the marker
   * is the rendering of a recorded fact, not a derived overlay), and only `true`
   * ever stamps the field. Lane-disjoint from the mid-loop `N/cap` review-progress
   * marker (in-review vs done).
   */
  readonly tolerated?: boolean;
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
  /**
   * The Linked PR overlay, set only on a `done` PRD whose live `gh` query found a
   * PR (open or merged) for its derived feature branch (CONTEXT.md, ADR 0013).
   * Absent on a non-`done` PRD (the overlay is gated to `done`), on a `done` PRD
   * with no PR, and when no lookup is wired in — so a finished PRD still needing a
   * PR is distinct from one that has one. A read-only overlay, recomputed each
   * scan, never persisted (ADR 0002 / 0003); opening/merging the PR leaves
   * {@link lane} unchanged (`done` stays `done`).
   */
  readonly linkedPr?: LinkedPr;
  /**
   * The needs-review overlay: `true` on a PRD with ≥1 Issue parked in
   * `human-review`, the one pipeline lane genuinely blocked on a human
   * ({@link derivePrdNeedsReview}). The first Issue→PRD roll-up marker, and the
   * first marker an *in-progress* PRD card carries — it lets the board answer
   * "which PRDs are blocked on me?" without zooming in. Set at scan/derivation
   * time from the Issues; a derived overlay like {@link linkedPr}, recomputed
   * each scan and never read from or written to `prd.md` (ADR 0002 / 0003), so a
   * resolved escalation clears it automatically on the next scan. Presence-only
   * (no count) and reason-agnostic. Disjoint from the `done`-only {@link linkedPr}
   * marker (needs-review implies not-`done`), so the two never co-render.
   */
  readonly needsReview?: boolean;
  /**
   * The stalled overlay: `true` on a PRD that has unblocked `ready-for-agent`
   * work waiting with nothing in flight ({@link derivePrdStalled}) — "dispatchable
   * work, but nobody's coming for it". A second Issue→PRD roll-up alongside
   * {@link needsReview}. Set at scan time purely from the Issues; a derived overlay
   * recomputed each scan and never read from or written to `prd.md` (ADR 0002 /
   * 0003). Whether the card actually *shows* the stalled marker additionally
   * requires **auto-run off** (the Reactor is coming when it's on) — that gate is
   * applied at render time where session state is known, not here. Presence-only.
   */
  readonly stalled?: boolean;
  /**
   * The tolerated overlay: `true` on a PRD with ≥1 Issue that merged with
   * tolerated findings ({@link derivePrdTolerated}) — a third Issue→PRD roll-up
   * alongside {@link needsReview} and {@link stalled}. Set at scan time purely
   * from the Issues; a derived overlay recomputed each scan and never read from or
   * written to `prd.md` (ADR 0002 / 0003). Purely **informational** (the neutral
   * `◌` family, never a call to action), so — unlike {@link stalled} — it needs no
   * session-state render gate and co-renders freely with the other PRD markers.
   * Presence-only.
   */
  readonly tolerated?: boolean;
}

export interface Board {
  readonly prds: readonly PRD[];
}
