import { describe, it, expect } from "vitest";
import { computeBindContext } from "./eligibility.js";
import type { PRD, Issue } from "../model.js";
import type { FrontierEntry, Classification } from "../dispatch/frontier.js";
import type { DispatchIssue } from "../dispatch/reader.js";

/**
 * A frontier entry of the given classification. Eligibility reads only the
 * `classification`, never the issue — so a stub issue suffices and stands as the
 * honest signal that the per-issue payload is irrelevant to `d`'s gate.
 */
function entry(classification: Classification): FrontierEntry {
  const issue = { id: "001-x.md" } as unknown as DispatchIssue;
  return classification === "spawn"
    ? { issue, classification }
    : { issue, classification, reason: "—" };
}

/** A PRD card with the fields eligibility reads (lane + linkedPr); rest are inert. */
function prd(over: Partial<PRD> = {}): PRD {
  return { id: "auth", title: "Auth", lane: "in-progress", issues: [], ...over };
}

/** An Issue card with the fields eligibility reads (lane + liveness); rest are inert. */
function issue(over: Partial<Issue> = {}): Issue {
  return { id: "001-x.md", title: "X", lane: "backlog", ...over };
}

describe("eligibility — computeBindContext", () => {
  describe("d (dispatch/resume) — frontier-based", () => {
    it("is dispatchable iff the frontier has ≥1 spawn candidate", () => {
      const yes = computeBindContext({
        selectedPrd: prd(),
        selectedIssue: undefined,
        frontier: [entry("queued"), entry("spawn")],
      });
      expect(yes.dispatchable).toBe(true);
    });

    it("is dispatchable on an in-progress PRD with a spawn candidate (resume preserved)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "in-progress" }),
        selectedIssue: undefined,
        frontier: [entry("spawn")],
      });
      expect(ctx.dispatchable).toBe(true);
    });

    it("is not dispatchable when the frontier has no spawn candidate (empty wave hidden)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "in-progress" }),
        selectedIssue: undefined,
        frontier: [entry("queued"), entry("blocked"), entry("skipped")],
      });
      expect(ctx.dispatchable).toBe(false);
    });

    it("is not dispatchable with no PRD selected", () => {
      const ctx = computeBindContext({
        selectedPrd: undefined,
        selectedIssue: undefined,
        frontier: [],
      });
      expect(ctx.dispatchable).toBe(false);
    });
  });

  describe("d — the direct `dispatchable` boolean (the hints' side-effect-free path)", () => {
    // The status-line hints can't spare the full frontier — they pass the boolean
    // from the dispatcher's `hasDispatchable` peek straight in. That direct branch
    // is what the App's hints path uses in production, so lock it at the unit level.

    it("takes the supplied `dispatchable: true` with no frontier", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "in-progress" }),
        selectedIssue: undefined,
        dispatchable: true,
      });
      expect(ctx.dispatchable).toBe(true);
    });

    it("takes the supplied `dispatchable: false` with no frontier", () => {
      const ctx = computeBindContext({
        selectedPrd: prd(),
        selectedIssue: undefined,
        dispatchable: false,
      });
      expect(ctx.dispatchable).toBe(false);
    });

    it("defaults to false when neither frontier nor dispatchable is supplied", () => {
      const ctx = computeBindContext({
        selectedPrd: prd(),
        selectedIssue: undefined,
      });
      expect(ctx.dispatchable).toBe(false);
    });

    it("lets the explicit `dispatchable` win over the frontier when both are supplied", () => {
      // The two callers each pass exactly one, but the precedence is part of the
      // contract: the explicit boolean is authoritative.
      const ctx = computeBindContext({
        selectedPrd: prd(),
        selectedIssue: undefined,
        dispatchable: false,
        frontier: [entry("spawn")],
      });
      expect(ctx.dispatchable).toBe(false);
    });
  });

  describe("P / go-to-PR — mutually exclusive on a done PRD", () => {
    it("no-PR done PRD ⇒ only P (prdDone && !prdHasPr)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "done", linkedPr: undefined }),
        selectedIssue: undefined,
        frontier: [],
      });
      expect(ctx.prdDone).toBe(true);
      expect(ctx.prdHasPr).toBe(false);
    });

    it("open-PR done PRD ⇒ only go-to-PR (prdDone && prdHasPr)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "done", linkedPr: { state: "open", url: "u" } }),
        selectedIssue: undefined,
        frontier: [],
      });
      expect(ctx.prdDone).toBe(true);
      expect(ctx.prdHasPr).toBe(true);
    });

    it("merged-PR done PRD ⇒ only go-to-PR (a merged PR still counts as a PR)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "done", linkedPr: { state: "merged", url: "u" } }),
        selectedIssue: undefined,
        frontier: [],
      });
      expect(ctx.prdHasPr).toBe(true);
    });

    it("non-done PRD ⇒ neither P nor go-to-PR nor X (prdDone false)", () => {
      const ctx = computeBindContext({
        selectedPrd: prd({ lane: "in-progress" }),
        selectedIssue: undefined,
        frontier: [],
      });
      expect(ctx.prdDone).toBe(false);
    });
  });

  describe("issue-level flags — r / R / K", () => {
    it("issueReadyForReview iff the selected Issue is in the ready-for-review lane", () => {
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "ready-for-review" }),
          frontier: [],
        }).issueReadyForReview,
      ).toBe(true);
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress" }),
          frontier: [],
        }).issueReadyForReview,
      ).toBe(false);
    });

    it("issueReadyForHuman iff the selected Issue is a ready-for-human card", () => {
      // The `ready-for-human` and `ready-for-agent` statuses both fold into the
      // single `ready` lane (model.ts), distinguished only by the `readyFor`
      // badge — so the flag keys off lane + badge, not a (non-existent)
      // `ready-for-human` lane.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "ready", readyFor: "human" }),
          frontier: [],
        }).issueReadyForHuman,
      ).toBe(true);
      // A ready-for-agent card sits in the same lane but carries the agent badge.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "ready", readyFor: "agent" }),
          frontier: [],
        }).issueReadyForHuman,
      ).toBe(false);
      // Every other lane is false.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "ready-for-review" }),
          frontier: [],
        }).issueReadyForHuman,
      ).toBe(false);
      // Nothing selected ⇒ false.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: undefined,
          frontier: [],
        }).issueReadyForHuman,
      ).toBe(false);
    });

    it("issueOrphan iff the selected Issue's liveness is orphaned", () => {
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress", liveness: "orphaned" }),
          frontier: [],
        }).issueOrphan,
      ).toBe(true);
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress", liveness: "live" }),
          frontier: [],
        }).issueOrphan,
      ).toBe(false);
    });

    it("issueLive iff the selected Issue's liveness is live", () => {
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress", liveness: "live" }),
          frontier: [],
        }).issueLive,
      ).toBe(true);
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress", liveness: "orphaned" }),
          frontier: [],
        }).issueLive,
      ).toBe(false);
    });

    it("issueReadyForAudit iff the selected Issue is a waiting ready-for-audit card", () => {
      // `c` is eligible only on a `ready-for-audit` Issue. Both `ready-for-audit`
      // (waiting) and `in-audit` (active) fold into the single `audit` lane
      // (model.ts), distinguished by the liveness overlay (ADR 0026): a
      // ready-for-audit card carries no liveness, an in-audit one always does
      // (live / orphaned / unknown). So the flag keys off lane + the *absence* of
      // liveness, mirroring how `m` keys off lane + the `readyFor` badge.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "audit" }),
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(true);
      // An in-audit card sits in the same lane but carries a liveness overlay —
      // it is the running auditor (`K`/`o` act on it), never a `c` candidate.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "audit", liveness: "live" }),
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(false);
      // An orphaned in-audit auditor (recover with `R`) is likewise not a `c` candidate.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "audit", liveness: "orphaned" }),
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(false);
      // An in-audit card with unknown liveness (query hiccup) is also not a `c` candidate.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "audit", liveness: "unknown" }),
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(false);
      // Every other lane is false.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "ready-for-review" }),
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(false);
      // Nothing selected ⇒ false.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: undefined,
          frontier: [],
        }).issueReadyForAudit,
      ).toBe(false);
    });

    it("issueApprovable iff the selected Issue is a human-review card with a recorded merge handoff", () => {
      // `A` is eligible only on a `human-review` Issue carrying a recorded worktree
      // + branch (the model's derived `approvable` overlay), regardless of the
      // escalation reason — reason-agnostic, so a hand-fixed conflict/non-convergence
      // Issue is still approvable (PRD user story 3).
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "human-review", approvable: true }),
          frontier: [],
        }).issueApprovable,
      ).toBe(true);
      // A human-review card missing the handoff is inert (no worktree/branch to merge).
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "human-review", approvable: false }),
          frontier: [],
        }).issueApprovable,
      ).toBe(false);
      // Reason-agnostic: it never reads humanReviewReason, only the approvable overlay.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({
            lane: "human-review",
            humanReviewReason: "conflict",
            approvable: true,
          }),
          frontier: [],
        }).issueApprovable,
      ).toBe(true);
      // Every other lane is false, even with an (impossible) stray approvable flag.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue({ lane: "in-progress" }),
          frontier: [],
        }).issueApprovable,
      ).toBe(false);
      // Nothing selected ⇒ false.
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: undefined,
          frontier: [],
        }).issueApprovable,
      ).toBe(false);
    });
  });

  describe("v — any card selected", () => {
    it("cardSelected when a PRD is selected at the board level", () => {
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: undefined,
          frontier: [],
        }).cardSelected,
      ).toBe(true);
    });

    it("cardSelected when an Issue is selected when zoomed", () => {
      expect(
        computeBindContext({
          selectedPrd: prd(),
          selectedIssue: issue(),
          frontier: [],
        }).cardSelected,
      ).toBe(true);
    });

    it("not cardSelected when nothing is selected", () => {
      expect(
        computeBindContext({
          selectedPrd: undefined,
          selectedIssue: undefined,
          frontier: [],
        }).cardSelected,
      ).toBe(false);
    });
  });

  it("carries the selected PRD's lane for the dispatch/resume label", () => {
    expect(
      computeBindContext({
        selectedPrd: prd({ lane: "backlog" }),
        selectedIssue: undefined,
        frontier: [entry("spawn")],
      }).prdLane,
    ).toBe("backlog");
    expect(
      computeBindContext({
        selectedPrd: undefined,
        selectedIssue: undefined,
        frontier: [],
      }).prdLane,
    ).toBeUndefined();
  });
});
