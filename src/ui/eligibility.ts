/**
 * The keybind **eligibility** computation — the single pure place that turns the
 * App's live selection into the per-binding {@link BindContext} flags every action
 * keybind's `eligible` predicate reads (ADR 0017). Ink-free and isolated so each
 * key's gating is unit-tested directly, never through the TUI.
 *
 * It **reuses** the eligibility facts the App already computes to gate the
 * handlers' no-ops rather than re-deriving them: the dispatch **frontier**
 * (`computeFrontier` / `readFrontier`), the **liveness** verdict on the selected
 * Issue card, and the **Linked PR** overlay on the selected PRD card. So making
 * keybinds eligibility-aware adds no new board reads — it only re-shapes facts
 * already on the model.
 *
 * Eligibility lives here in App-space, never in the registry (ADR 0017): the
 * registry stays a seam-free pure router that consumes the flags this module
 * produces.
 */

import type { Issue, PRD } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";

/**
 * The live selection + the already-computed facts the eligibility flags derive
 * from. `frontier` is the selected PRD's dispatch frontier (the App reads it via
 * the dispatcher seam); the selected PRD/Issue carry their own liveness and
 * Linked-PR overlays, recomputed each scan.
 */
export interface BindInputs {
  /** The selected PRD card, or `undefined` when nothing is selected. */
  readonly selectedPrd: PRD | undefined;
  /** The selected Issue card (only when zoomed), or `undefined`. */
  readonly selectedIssue: Issue | undefined;
  /**
   * The selected PRD's dispatch frontier, reused not re-derived. The matcher path
   * passes it because a `d` press also needs the frontier *entries* to dispatch;
   * `dispatchable` is then derived from it (a `spawn` candidate present?).
   */
  readonly frontier?: readonly FrontierEntry[];
  /**
   * Whether the selected PRD has dispatchable work, supplied directly when the
   * caller has already computed just that fact and has no frontier entries to
   * spare — the status-line hints read the dispatcher's side-effect-free
   * `hasDispatchable` peek (ADR 0017) rather than the full {@link frontier}, so
   * they pass the boolean here. Takes precedence over deriving from `frontier`;
   * exactly one of the two is supplied.
   */
  readonly dispatchable?: boolean;
}

/**
 * The per-binding eligibility flags the matcher and (a later slice) the hints
 * route off. Plain data — one fact per gated key in the eligibility table — so a
 * binding's `eligible(ctx)` predicate is a single boolean read with no seam
 * access of its own (ADR 0017).
 */
export interface BindContext {
  /**
   * `d` — the selected PRD's frontier has ≥1 `spawn` candidate (an unblocked
   * `ready-for-agent` Issue). **Frontier-based, not lane-based**, so `d` stays
   * available to *resume* an in-progress PRD with newly-unblocked work when
   * auto-run is off (ADR 0017).
   */
  readonly dispatchable: boolean;
  /** `X` / the PR keys' precondition — the selected PRD is in the `done` lane. */
  readonly prdDone: boolean;
  /**
   * Whether the selected PRD has a Linked PR (open *or* merged). With
   * {@link prdDone} this splits a done PRD's PR keys: no-PR ⇒ only `P`, PR ⇒ only
   * `go to PR` — mutually exclusive.
   */
  readonly prdHasPr: boolean;
  /** `r` — the selected Issue is in the `ready-for-review` lane. */
  readonly issueReadyForReview: boolean;
  /**
   * `m` — the selected Issue is a `ready-for-human` card. The `ready-for-human`
   * and `ready-for-agent` statuses both fold into the single `ready` lane
   * (model.ts), distinguished only by the `readyFor` badge, so this keys off lane
   * + badge rather than a (non-existent) `ready-for-human` lane. The board's first
   * human-triggered status flip with no spawn behind it (CONTEXT.md → mark done).
   */
  readonly issueReadyForHuman: boolean;
  /** `R` — the selected Issue's liveness verdict is `orphaned`. */
  readonly issueOrphan: boolean;
  /** `K` — the selected Issue's liveness verdict is `live`. */
  readonly issueLive: boolean;
  /** `v` — any card is selected (a PRD at the board level, an Issue when zoomed). */
  readonly cardSelected: boolean;
  /**
   * The selected PRD's derived lane, carried so the hints can key `d`'s
   * dispatch/resume label off it (backlog ⇒ "dispatch", in-progress ⇒ "resume").
   * `undefined` when no PRD is selected. The matcher never reads it — it is for
   * the label override only.
   */
  readonly prdLane: PRD["lane"] | undefined;
}

/**
 * Turn the live selection (and its reused frontier / liveness / Linked-PR facts)
 * into the {@link BindContext} flags. Pure data-in/data-out — no I/O, no seam
 * access — so each key's gating is unit-tested as constructed-input/expected-flag.
 */
export function computeBindContext(inputs: BindInputs): BindContext {
  const { selectedPrd, selectedIssue, frontier, dispatchable } = inputs;
  return {
    dispatchable:
      dispatchable ??
      (frontier?.some((e) => e.classification === "spawn") ?? false),
    prdDone: selectedPrd?.lane === "done",
    prdHasPr: selectedPrd?.linkedPr !== undefined,
    issueReadyForReview: selectedIssue?.lane === "ready-for-review",
    issueReadyForHuman:
      selectedIssue?.lane === "ready" && selectedIssue.readyFor === "human",
    issueOrphan: selectedIssue?.liveness === "orphaned",
    issueLive: selectedIssue?.liveness === "live",
    cardSelected: selectedPrd !== undefined || selectedIssue !== undefined,
    prdLane: selectedPrd?.lane,
  };
}
