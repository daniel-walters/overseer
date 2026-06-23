import type { PrQueryResult } from "./linkedPr.js";
import type { LinkedPr } from "../model.js";

/**
 * The overlay aggregate: the pure roll-up from a stack's per-slice PR query
 * results to the single {@link LinkedPr} a `done` PRD card carries (CONTEXT.md →
 * Linked PR, ADR 0025). When Open PR materialized a stack (≥2 slices), there is no
 * single PR to surface — this module folds all the slice PRs' states into an
 * aggregate `N/M merged` signal: M is the slice count, N the number merged, and
 * the PRD reads as fully landed only at N = M.
 *
 * It is pure data-in/data-out (no `gh`, no seam), so the roll-up — the
 * half-merged *in-progress* reading, and the M = 1 collapse back to today's
 * three-state marker — is reasoned about and tested directly. The impure
 * {@link import("./linkedPr.js").createLinkedPrLookup} derives each slice branch,
 * queries it through the {@link import("./linkedPr.js").PrSeam}, and hands the
 * ordered results here.
 */

/**
 * Reduce a PRD's per-Issue `slice:` labels to the **distinct slice labels in
 * chain order** — slice 1 (the bottom / entry point) first. Several Issues share
 * each slice, but the overlay queries one branch per *slice*, so the labels fold
 * to one entry per distinct leading number, ordered ascending.
 *
 * Pure, and the input to deriving the per-slice branch names the overlay queries.
 * A label with no leading slice number is dropped (it can't be placed in the
 * chain), mirroring how the cut planner skips a NaN slice key — so a malformed
 * label never strands the whole stack.
 */
export function orderedSliceLabels(
  labels: readonly string[],
): readonly string[] {
  // slice number → the first label seen for it, so duplicates across Issues fold
  // to one branch per slice and ties keep a stable label.
  const byNumber = new Map<number, string>();
  for (const label of labels) {
    const n = Number.parseInt(label, 10);
    if (Number.isNaN(n)) continue; // no leading digit — not placeable in the chain
    if (!byNumber.has(n)) byNumber.set(n, label);
  }
  return [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, label]) => label);
}

/**
 * Roll a stack's per-slice PR query results — **in slice order, slice 1 (the
 * bottom / entry point) first** — into the PRD's {@link LinkedPr} overlay, or
 * `undefined` for no marker.
 *
 * - **M = 1** (a single slice) collapses to today's plain three-state marker: an
 *   OPEN slice → `open`, a MERGED slice → `merged`, an absent slice → no overlay.
 *   No `stack` count is attached, so the single-PR card is unchanged.
 * - **M ≥ 2** is a real stack: `state` is `merged` only when *every* slice PR has
 *   landed (N = M), else `open` (any `0 ≤ N < M` is the *in-progress* reading);
 *   `url` is the **bottom** PR's (slice 1's, or the first slice that carries a PR
 *   if the bottom has none yet), the entry point `go to PR` opens and a human
 *   merges first; and `stack` carries `{ merged: N, total: M }` so the card
 *   renders the `N/M merged` signal. A slice with no PR yet counts toward M but
 *   not N (it has not landed). When *no* slice carries a PR at all — the stack
 *   isn't opened, or every query degraded — there is no marker (mirroring the
 *   single-PR no-PR case), not a hollow `0/M merged`.
 */
export function rollUpStack(
  slices: readonly (PrQueryResult | undefined)[],
): LinkedPr | undefined {
  if (slices.length <= 1) {
    const only = slices[0];
    if (only === undefined) return undefined;
    return { state: only.state === "OPEN" ? "open" : "merged", url: only.url };
  }

  const total = slices.length;
  // The bottom PR (slice 1) is the stack's entry point: its url is what `go to PR`
  // opens. A bottom slice with no PR yet has no url to open — fall back to the
  // first slice that does carry one so the marker still routes somewhere sensible.
  const entry = slices.find((s) => s !== undefined);
  // No slice carries a PR ⇒ the stack isn't actually opened (or every query
  // degraded): no marker, mirroring the single-PR no-PR case — not a hollow
  // `0/M merged` with no url to open.
  if (entry === undefined) return undefined;

  const merged = slices.filter((s) => s?.state === "MERGED").length;
  return {
    state: merged === total ? "merged" : "open",
    url: entry.url,
    stack: { merged, total },
  };
}
