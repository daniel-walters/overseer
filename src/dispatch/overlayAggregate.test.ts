import { describe, it, expect } from "vitest";
import { rollUpStack, orderedSliceLabels } from "./overlayAggregate.js";

/**
 * The overlay aggregate is the pure roll-up at the heart of the stack-aware Linked
 * PR overlay (CONTEXT.md → Linked PR, ADR 0025): given the per-slice PR query
 * results in slice order (slice 1 / bottom first), it folds them to the one
 * {@link LinkedPr} a `done` PRD card carries — the `N/M merged` aggregate for a
 * real stack (M ≥ 2), collapsing to today's plain three-state marker at M = 1.
 *
 * Pure data-in/data-out (no seam, no `gh`), so the whole roll-up — including the
 * half-merged *in-progress* reading and the M = 1 collapse — is asserted directly
 * against constructed per-slice states, mirroring `parsePrList` and the cut
 * planner.
 */

describe("orderedSliceLabels — the distinct slice labels in chain order", () => {
  it("dedupes the per-Issue labels and orders them ascending by slice number", () => {
    // Several Issues share each slice; the overlay queries one branch per *slice*,
    // bottom-up. So the per-Issue labels fold to the distinct labels ordered by
    // their leading number — slice 1 (the bottom) first.
    expect(
      orderedSliceLabels(["2-api", "1-schema", "2-api", "3-ui", "1-schema"]),
    ).toEqual(["1-schema", "2-api", "3-ui"]);
  });

  it("drops labels with no leading slice number", () => {
    // A malformed label (no leading digit) can't be placed in the chain, so it is
    // dropped — mirroring the cut planner, which skips the same NaN slice key.
    expect(orderedSliceLabels(["1-schema", "broken", "2-api"])).toEqual([
      "1-schema",
      "2-api",
    ]);
  });

  it("returns the single distinct label for a one-slice PRD", () => {
    expect(orderedSliceLabels(["1-only", "1-only"])).toEqual(["1-only"]);
  });
});

describe("rollUpStack — single-slice (M = 1) collapse to the three-state marker", () => {
  it("collapses one OPEN slice PR to the plain open marker (no count)", () => {
    // M = 1 is exactly today's single-PR case: the marker reads as the plain
    // three states with no `stack` count, so the no-stack card is byte-identical.
    expect(rollUpStack([{ state: "OPEN", url: "https://gh/1" }])).toEqual({
      state: "open",
      url: "https://gh/1",
    });
  });

  it("collapses one MERGED slice PR to the plain merged marker (no count)", () => {
    expect(rollUpStack([{ state: "MERGED", url: "https://gh/2" }])).toEqual({
      state: "merged",
      url: "https://gh/2",
    });
  });

  it("collapses one absent slice PR to no overlay (the marker disappears)", () => {
    // No PR on the lone slice ⇒ no marker, exactly the three-state's third state.
    expect(rollUpStack([undefined])).toBeUndefined();
  });
});

describe("rollUpStack — the N/M merged aggregate (M ≥ 2)", () => {
  it("reads a fully-merged stack as landed: N = M, state merged, bottom url", () => {
    // Every slice PR merged ⇒ the whole feature has landed: the PRD reads done
    // (`merged`) and the count is M/M. The url is the bottom PR's (slice 1).
    expect(
      rollUpStack([
        { state: "MERGED", url: "https://gh/bottom" },
        { state: "MERGED", url: "https://gh/mid" },
        { state: "MERGED", url: "https://gh/top" },
      ]),
    ).toEqual({
      state: "merged",
      url: "https://gh/bottom",
      stack: { merged: 3, total: 3 },
    });
  });

  it("reads a half-merged stack as in-progress (0 < N < M): state open, N/M count", () => {
    // The bottom slice landed but the top is still open: the feature has NOT fully
    // landed, so the headline is `open` (in-progress), never `merged` — only N = M
    // reads as done. The count surfaces 2/3 so the board shows the partial landing.
    expect(
      rollUpStack([
        { state: "MERGED", url: "https://gh/bottom" },
        { state: "MERGED", url: "https://gh/mid" },
        { state: "OPEN", url: "https://gh/top" },
      ]),
    ).toEqual({
      state: "open",
      url: "https://gh/bottom",
      stack: { merged: 2, total: 3 },
    });
  });

  it("counts a slice with no PR yet toward M but not N", () => {
    // A slice branch with no PR opened yet still counts toward the total (M slices
    // exist) but not toward landed (N) — it has not merged. So a stack with nothing
    // merged reads as 0/M, in-progress.
    expect(
      rollUpStack([
        { state: "OPEN", url: "https://gh/bottom" },
        undefined,
        undefined,
      ]),
    ).toEqual({
      state: "open",
      url: "https://gh/bottom",
      stack: { merged: 0, total: 3 },
    });
  });

  it("opens the bottom PR (slice 1) even when an upper slice merged first out of order", () => {
    // `go to PR` must open the stack's entry point — slice 1 — regardless of which
    // slice GitHub happens to show merged. The bottom is first in the slice-ordered
    // input, so its url is taken even though the top is the one merged here.
    expect(
      rollUpStack([
        { state: "OPEN", url: "https://gh/bottom" },
        { state: "OPEN", url: "https://gh/mid" },
        { state: "MERGED", url: "https://gh/top" },
      ])?.url,
    ).toBe("https://gh/bottom");
  });

  it("reports no overlay when no slice branch has a PR at all (the stack isn't opened)", () => {
    // A `done` PRD that hasn't actually opened its stack (or whose every slice
    // query degraded) carries no PR anywhere — so, like the single-PR no-PR case,
    // the marker disappears rather than reading a hollow `0/M merged` with no url.
    expect(rollUpStack([undefined, undefined, undefined])).toBeUndefined();
  });

  it("falls back to the next slice's url when the bottom slice has no PR yet", () => {
    // A stack whose bottom branch has no PR opened yet still routes `go to PR`
    // somewhere sensible — the first slice that does carry a PR — rather than an
    // empty url, since the marker is shown the moment any slice PR exists.
    expect(
      rollUpStack([
        undefined,
        { state: "OPEN", url: "https://gh/mid" },
      ])?.url,
    ).toBe("https://gh/mid");
  });
});
