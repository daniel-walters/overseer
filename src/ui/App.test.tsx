import { describe, it, expect, vi } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { App, dispatchOutcomeNotice } from "./App.js";
import { KEYBINDS } from "./keybinds.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchResult } from "../dispatch/dispatch.js";
import type { DispatchIssue } from "../dispatch/reader.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";
import type { AuditPreview as AuditPreviewData } from "../audit/auditReader.js";
import type {
  RedispatchPreview as RedispatchPreviewData,
  RollbackOutcome,
} from "../dispatch/rollback.js";
import type {
  KillPreview as KillPreviewData,
  KillOutcome,
} from "../dispatch/kill.js";
import type { OpenPrPreviewData } from "./OpenPrPreview.js";
import type { OpenPrResult } from "../dispatch/openPr.js";
import type { DeletePreviewData } from "./DeletePreview.js";
import type { DeleteResult } from "../dispatch/deletePrd.js";
import type { MarkDonePreviewData } from "./MarkDonePreview.js";
import type { ApprovePreviewData } from "./ApprovePreview.js";
import type { ApproveResult } from "../review/approve.js";
import { createDelete } from "../dispatch/deletePrd.js";
import type { CardDetail } from "./detailReader.js";
import type { AgentOutput } from "./agentOutputReader.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const ARROW_DOWN = ESC + "[B";
const ARROW_UP = ESC + "[A";
const ARROW_RIGHT = ESC + "[C";
const ARROW_LEFT = ESC + "[D";

const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Let Ink flush input and re-render. */
const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * Poll the rendered frame until `predicate` holds, for assertions that depend on
 * the dispatch confirm's deferred `setTimeout(0)` settle. A single fixed `tick`
 * is racy under full-suite CPU load (the deferred spawn → refresh → re-render can
 * outlast 20ms), so wait on the *condition* rather than a fixed delay. Throws the
 * last frame on timeout so a real failure still reports usefully.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  { timeoutMs = 1000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = stripAnsi(lastFrame() ?? "");
  while (!predicate(frame)) {
    if (Date.now() > deadline) {
      throw new Error(`waitForFrame timed out; last frame:\n${frame}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
    frame = stripAnsi(lastFrame() ?? "");
  }
  return frame;
}

const board: Board = {
  prds: [
    {
      id: "auth",
      title: "AuthPRD",
      lane: "backlog",
      issues: [
        { id: "010-login", title: "Login", lane: "backlog" },
        { id: "020-oauth", title: "OAuth", lane: "ready", readyFor: "agent" },
        { id: "030-review", title: "Review", lane: "ready", readyFor: "human" },
      ],
    },
    {
      id: "billing",
      title: "BillPRD",
      lane: "backlog",
      issues: [{ id: "010-invoice", title: "Invoice", lane: "backlog" }],
    },
  ],
};

describe("App", () => {
  it("starts at the board level showing PRD cards, not Issue cards", () => {
    const { lastFrame } = render(<App board={board} />);
    const frame = stripAnsi(lastFrame() ?? "");

    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("BillPRD");
    expect(frame).not.toContain("Login");
  });

  it("zooms into the selected PRD's Issues on Enter, switching the rendered level", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER);
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Login");
    expect(frame).toContain("OAuth");
    // The other PRD's card is no longer shown — we're a level down.
    expect(frame).not.toContain("BillPRD");
  });

  it("renders the human and agent ready badges at the Issue level", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("🤖");
    expect(frame).toContain("🧑");
  });

  it("backs out from the Issue level to the board on Esc", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER);
    await tick();
    stdin.write(ESC);
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("BillPRD");
    expect(frame).not.toContain("Login");
  });

  it("zooms into the PRD selected after moving down", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    // billing is the second board card; its Issue is Invoice.
    expect(frame).toContain("Invoice");
    expect(frame).not.toContain("Login");
  });

  it("keeps the zoom and selection when handed a fresh board (live refresh)", async () => {
    const { stdin, lastFrame, rerender } = render(<App board={board} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();

    // A re-scan produces an equal-but-new board object.
    rerender(<App board={structuredClone(board)} />);
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("OAuth"); // still at the Issue level
    expect(frame).not.toContain("BillPRD");
  });

  it("backs out to the board on q when zoomed, rather than quitting", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("q"); // first q backs out
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("BillPRD"); // back at the board level
    expect(frame).not.toContain("OAuth");
  });

  it("quits on q at the board level (app stops responding to input)", async () => {
    const { stdin, frames } = render(<App board={board} />);

    stdin.write("q");
    await tick();
    const framesAfterQuit = frames.length;

    // Once quit, the app has unmounted: further input produces no new frame.
    stdin.write(ARROW_DOWN);
    await tick();
    expect(frames.length).toBe(framesAfterQuit);
  });
});

describe("App dispatch", () => {
  function di(id: string): DispatchIssue {
    return { id, title: id, path: `/root/auth/${id}`, status: "ready-for-agent", blockedBy: [], repo: "/r", worktree: undefined, branch: undefined, deviation: undefined, reviewVerdict: undefined, slice: undefined, reviewFindings: undefined, reviewTolerated: undefined, body: "" };
  }

  /** A frontier with one spawn candidate and one skipped Issue. */
  function fakeFrontier(prdId: string): readonly FrontierEntry[] {
    return [
      { issue: di("010-spawn.md"), classification: "spawn" },
      { issue: di("020-skip.md"), classification: "skipped", reason: `(${prdId}) not ready` },
    ];
  }

  /** A dispatcher whose seams are spies, with a sensible default frontier. */
  function spyDispatcher(
    overrides: Partial<{
      readFrontier: (id: string) => readonly FrontierEntry[];
      dispatch: (f: readonly FrontierEntry[]) => DispatchResult;
    }> = {},
  ) {
    const frontierFor = overrides.readFrontier ?? fakeFrontier;
    // By default the dispatch reports every spawn candidate as launched — a fully
    // successful wave — so the confirm notice reads "Dispatched N". Tests that
    // model a failed/partial dispatch pass their own `dispatch` returning skips.
    const dispatchFor =
      overrides.dispatch ??
      ((f: readonly FrontierEntry[]): DispatchResult => ({
        launched: f.filter((e) => e.classification === "spawn").length,
        skipped: 0,
      }));
    return {
      readFrontier: vi.fn(frontierFor),
      // The hints' side-effect-free peek mirrors the frontier the matcher reads, so
      // a fixture that is dispatchable for `d` is also dispatchable for the bar. A
      // *separate* spy from `readFrontier` so the hints' per-render peek never
      // inflates the strict `readFrontier` call counts the keypress tests assert.
      hasDispatchable: vi.fn((id: string) =>
        frontierFor(id).some((e) => e.classification === "spawn"),
      ),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => DispatchResult>(dispatchFor),
    };
  }

  it("opens a modal preview on d at the board level", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Dispatch");
    expect(frame).toContain("010-spawn.md");
    // The frontier was read for the selected (first) PRD.
    expect(dispatcher.readFrontier).toHaveBeenCalledWith("auth");
  });

  it("does nothing on d at the issue (zoomed) level", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("d");
    await tick();

    expect(dispatcher.readFrontier).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch AuthPRD");
  });

  it("suppresses navigation while the preview is open", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d"); // open preview on AuthPRD
    await tick();
    stdin.write(ARROW_DOWN); // would move selection if not suppressed
    await tick();
    // Still modal, still on AuthPRD's frontier.
    expect(dispatcher.readFrontier).toHaveBeenCalledTimes(1);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Dispatch");

    stdin.write(ESC);
    await tick();
    // The board selection never moved while the modal was up.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).not.toContain("Dispatch AuthPRD");
  });

  it("runs the dispatch on Enter, then closes the modal", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(fakeFrontier("auth"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch AuthPRD");
  });

  it("runs the dispatch on y as well as Enter", async () => {
    const dispatcher = spyDispatcher();
    const { stdin } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write("y");
    await tick();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("shows an in-flight notice on confirm and re-scans once the spawn returns (issue #74)", async () => {
    // The spawn edge blocks for seconds on `claude --bg` cold-start, so confirm
    // surfaces an immediate "Dispatching N agents…" notice (N = spawn candidates,
    // one in fakeFrontier) and re-scans on demand once the deferred loop returns,
    // so the cards flip to in-progress without waiting on the debounced watcher.
    // Once the loop returns the in-flight line settles to a past-tense outcome.
    const dispatcher = spyDispatcher();
    const refresh = vi.fn();
    const { stdin, lastFrame } = render(
      <App board={board} dispatcher={dispatcher} refresh={refresh} />,
    );

    stdin.write("d");
    await tick();
    stdin.write(ENTER);
    await tick();

    // The settled outcome is on the status line (the modal is gone). Wait on the
    // deferred settle rather than a single fixed tick (flaky under load).
    const frame = await waitForFrame(lastFrame, (f) =>
      f.includes("Dispatched 1 agent in the background"),
    );
    // The deferred spawn ran, and the board was re-scanned on demand.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(frame).not.toContain("Dispatch AuthPRD");
  });

  it("settles the in-flight notice to an outcome once the spawn returns, without a keypress", async () => {
    // The "Dispatching…" line is a progress signal, not an outcome: it used to
    // stay up until the next keypress, leaving it stuck on screen long after the
    // agents had spawned (it only vanished when the cursor moved). The deferred
    // loop now swaps it for a settled past-tense line on return — no keypress.
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write(ENTER);
    // No movement key — the notice settles on its own once the deferred loop returns.
    const frame = await waitForFrame(lastFrame, (f) => f.includes("Dispatched"));
    expect(frame).not.toContain("Dispatching");
  });

  it("reports a failure outcome when the dispatch launched nothing (the silent-dispatch bug)", async () => {
    // The regression guard for the dirty-tree bug: confirm fired, the modal
    // counted N spawn candidates, but every repo's setup failed so nothing
    // launched. The settled notice must say so — and point at the log — rather
    // than the old unconditional "Dispatched N". (The skip was logged +
    // suppressed by the edge; here we only assert the user-facing notice.)
    const dispatcher = spyDispatcher({
      dispatch: () => ({ launched: 0, skipped: 1 }),
    });
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write(ENTER);

    const frame = await waitForFrame(lastFrame, (f) =>
      f.includes("Dispatched no agents"),
    );
    expect(frame).toContain("failed to start");
    expect(frame).not.toContain("Dispatched 1 agent in the background");
  });

  it("clears the settled dispatch notice on the next keypress (a one-shot, like every notice)", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes("Dispatched"));

    stdin.write("l"); // any movement key
    await waitForFrame(lastFrame, (f) => !f.includes("Dispatched"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatched");
  });

  it("cancels on Esc without dispatching, leaving the board untouched", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).not.toContain("Dispatch AuthPRD");
  });

  it("quits on q from the modal without dispatching", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, frames } = render(<App board={board} dispatcher={dispatcher} />);

    stdin.write("d"); // open the preview
    await tick();
    stdin.write("q"); // q quits everywhere, including the modal
    await tick();
    const framesAfterQuit = frames.length;

    // No dispatch happened, and the app unmounted: further input → no new frame.
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    stdin.write(ARROW_DOWN);
    await tick();
    expect(frames.length).toBe(framesAfterQuit);
  });

  it("does nothing on d when no dispatcher is wired", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("d");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch AuthPRD");
  });

  it("keeps the modal up and labelled from the open-time capture if a re-scan removes its PRD", async () => {
    const dispatcher = spyDispatcher();
    const { stdin, lastFrame, rerender } = render(
      <App board={board} dispatcher={dispatcher} />,
    );

    stdin.write("d"); // open the preview on AuthPRD (first card)
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Dispatch AuthPRD");

    // A live re-scan removes AuthPRD entirely from under the open modal.
    const withoutAuth: Board = { prds: board.prds.filter((p) => p.id !== "auth") };
    rerender(<App board={withoutAuth} dispatcher={dispatcher} />);
    await tick();

    // The modal is still up and still names AuthPRD (the frozen capture), not
    // the now-selected billing PRD, and a confirm dispatches AuthPRD's frontier.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Dispatch AuthPRD");

    stdin.write(ENTER);
    await tick();
    expect(dispatcher.dispatch).toHaveBeenCalledWith(fakeFrontier("auth"));
  });
});

describe("App review", () => {
  function di(id: string, overrides: Partial<DispatchIssue> = {}): DispatchIssue {
    return {
      id,
      title: id,
      path: `/root/auth/${id}`,
      status: "ready-for-review",
      blockedBy: [],
      repo: "/r",
      worktree: "/wt/blue-cat-fox",
      branch: "blue-cat-fox",
      deviation: undefined,
      reviewVerdict: undefined,
      slice: undefined,
      reviewFindings: undefined,
      reviewTolerated: undefined,
      body: "",
      ...overrides,
    };
  }

  const prdContext = { prdTitle: "AuthPRD", prdBody: "auth", featureBranch: "auth" };

  // `r` is eligible only on a `ready-for-review` Issue (ADR 0017), so the
  // review-flow tests select one: AuthPRD's first Issue sits in that lane (which
  // derives the PRD to `in-progress`). A single PRD keeps it the default-selected
  // card regardless of which board column its derived lane lands in. The reviewer's
  // *deeper* eligibility (the skip-reason path) is a separate layer exercised
  // through the `spyReviewer` response, independent of this card lane.
  const reviewBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [{ id: "010-login", title: "Login", lane: "ready-for-review" }],
      },
    ],
  };

  function reviewable(id: string): ReviewPreviewData {
    return { issue: di(id), eligibility: { reviewable: true }, ...prdContext };
  }

  function ineligible(id: string, reason: string): ReviewPreviewData {
    return {
      issue: di(id, { status: "in-progress" }),
      eligibility: { reviewable: false, reason },
      ...prdContext,
    };
  }

  function spyReviewer(
    readReview: (prdId: string, issueId: string) => ReviewPreviewData | undefined = (
      _p,
      id,
    ) => reviewable(id),
  ) {
    return {
      readReview: vi.fn(readReview),
      review: vi.fn<(p: ReviewPreviewData) => void>(),
    };
  }

  it("opens a review preview on r at the Issue level for the selected Issue", async () => {
    const reviewer = spyReviewer();
    const { stdin, lastFrame } = render(<App board={reviewBoard} reviewer={reviewer} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("r");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Review 010-login");
    // The worktree path only appears inside the review modal.
    expect(frame).toContain("/wt/blue-cat-fox");
    // The selected (first) Issue of AuthPRD was read.
    expect(reviewer.readReview).toHaveBeenCalledWith("auth", "010-login");
  });

  it("does nothing on r at the board level (review is Issue-level only)", async () => {
    const reviewer = spyReviewer();
    const { stdin, lastFrame } = render(<App board={board} reviewer={reviewer} />);

    stdin.write("r");
    await tick();

    expect(reviewer.readReview).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("shows a skip reason and spawns nothing for an ineligible Issue", async () => {
    const reviewer = spyReviewer((_p, id) => ineligible(id, "status is \"in-progress\", not ready-for-review"));
    const { stdin, lastFrame } = render(<App board={reviewBoard} reviewer={reviewer} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("r");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("in-progress");

    // Confirming an ineligible preview spawns nothing.
    stdin.write(ENTER);
    await tick();
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("runs the review on Enter for an eligible Issue, then closes the modal", async () => {
    const reviewer = spyReviewer();
    const { stdin, lastFrame } = render(<App board={reviewBoard} reviewer={reviewer} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("r"); // open review preview
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(reviewer.review).toHaveBeenCalledWith(reviewable("010-login"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("cancels the review on Esc without spawning", async () => {
    const reviewer = spyReviewer();
    const { stdin, lastFrame } = render(<App board={reviewBoard} reviewer={reviewer} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("r");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(reviewer.review).not.toHaveBeenCalled();
    // Back at the Issue level, modal closed.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("does nothing on r when no reviewer is wired", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("r");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });
});

describe("App audit (c on a ready-for-audit Issue)", () => {
  function di(id: string, overrides: Partial<DispatchIssue> = {}): DispatchIssue {
    return {
      id,
      title: id,
      path: `/root/auth/${id}`,
      status: "ready-for-audit",
      blockedBy: [],
      repo: "/repos/backend",
      worktree: "/wt/blue-cat-fox",
      branch: "blue-cat-fox",
      deviation: undefined,
      reviewVerdict: undefined,
      slice: undefined,
      reviewFindings: undefined,
      reviewTolerated: undefined,
      body: "",
      ...overrides,
    };
  }

  const prdContext = { prdTitle: "AuthPRD", prdBody: "auth" };

  // `c` is eligible only on a `ready-for-audit` Issue (ADR 0026), so the
  // audit-flow tests select one: a single PRD with its first Issue in the
  // `audit` lane (no liveness = waiting). A single PRD keeps it the
  // default-selected card. The auditor's deeper eligibility (the skip-reason
  // path) is exercised through the `spyAuditor` response.
  const auditBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [{ id: "010-login", title: "Login", lane: "audit" }],
      },
    ],
  };

  function auditable(id: string): AuditPreviewData {
    return { issue: di(id), eligibility: { auditable: true }, ...prdContext };
  }

  function ineligible(id: string, reason: string): AuditPreviewData {
    return {
      issue: di(id, { status: "in-audit" }),
      eligibility: { auditable: false, reason },
      ...prdContext,
    };
  }

  function spyAuditor(
    readAudit: (prdId: string, issueId: string) => AuditPreviewData | undefined = (
      _p,
      id,
    ) => auditable(id),
  ) {
    return {
      readAudit: vi.fn(readAudit),
      audit: vi.fn<(p: AuditPreviewData) => void>(),
    };
  }

  it("opens an audit preview on c at the Issue level for the selected Issue", async () => {
    const auditor = spyAuditor();
    const { stdin, lastFrame } = render(<App board={auditBoard} auditor={auditor} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("c");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Audit 010-login");
    expect(frame).toContain("/wt/blue-cat-fox");
    expect(auditor.readAudit).toHaveBeenCalledWith("auth", "010-login");
  });

  it("does nothing on c at the board level (audit is Issue-level only)", async () => {
    const auditor = spyAuditor();
    const { stdin, lastFrame } = render(<App board={board} auditor={auditor} />);

    stdin.write("c");
    await tick();

    expect(auditor.readAudit).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("shows a skip reason and spawns nothing for an ineligible Issue", async () => {
    const auditor = spyAuditor((_p, id) => ineligible(id, "status is \"in-audit\", not ready-for-audit"));
    const { stdin, lastFrame } = render(<App board={auditBoard} auditor={auditor} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("c");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("in-audit");

    // Confirming an ineligible preview spawns nothing.
    stdin.write(ENTER);
    await tick();
    expect(auditor.audit).not.toHaveBeenCalled();
  });

  it("runs the audit on Enter for an eligible Issue, then closes the modal", async () => {
    const auditor = spyAuditor();
    const { stdin, lastFrame } = render(<App board={auditBoard} auditor={auditor} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("c"); // open audit preview
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(auditor.audit).toHaveBeenCalledTimes(1);
    expect(auditor.audit).toHaveBeenCalledWith(auditable("010-login"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("cancels the audit on Esc without spawning", async () => {
    const auditor = spyAuditor();
    const { stdin, lastFrame } = render(<App board={auditBoard} auditor={auditor} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("c");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(auditor.audit).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });

  it("does nothing on c when no auditor is wired", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("c");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/wt/blue-cat-fox");
  });
});

describe("App mark done (m on a ready-for-human Issue)", () => {
  // A board whose selected (first) Issue is a `ready-for-human` card — the only
  // state `m` lights up on. `ready-for-human` folds into the `ready` lane carrying
  // the `human` badge (model.ts), so the card is `lane: "ready", readyFor: "human"`.
  // A second `ready-for-agent` card pins the human-vs-agent gate.
  const humanBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [
          { id: "010-secret", title: "Provision a secret", lane: "ready", readyFor: "human" },
          { id: "020-build", title: "Build it", lane: "ready", readyFor: "agent" },
        ],
      },
    ],
  };

  function previewFor(issueId: string): MarkDonePreviewData {
    return { issueTitle: issueId, issuePath: `/root/auth/${issueId}` };
  }

  function spyMarkDone(
    readMarkDone: (prdId: string, issueId: string) => MarkDonePreviewData | undefined = (
      _p,
      id,
    ) => previewFor(id),
  ) {
    return {
      readMarkDone: vi.fn(readMarkDone),
      markDone: vi.fn<(p: MarkDonePreviewData) => void>(),
    };
  }

  it("opens a confirm preview on m at the Issue level for a ready-for-human Issue", async () => {
    const markDone = spyMarkDone();
    const { stdin, lastFrame } = render(<App board={humanBoard} markDone={markDone} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues (selects 010-secret)
    await tick();
    stdin.write("m");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Mark"); // the preview titles the action
    expect(frame).toContain("ready-for-human → done"); // and names the transition
    expect(markDone.readMarkDone).toHaveBeenCalledWith("auth", "010-secret");
  });

  it("does nothing on m at the board level (mark-done is Issue-level only)", async () => {
    const markDone = spyMarkDone();
    const { stdin } = render(<App board={humanBoard} markDone={markDone} />);

    stdin.write("m");
    await tick();

    expect(markDone.readMarkDone).not.toHaveBeenCalled();
  });

  it("does nothing on m for a ready-for-agent Issue (the action is human-gated)", async () => {
    const markDone = spyMarkDone();
    const { stdin } = render(<App board={humanBoard} markDone={markDone} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write(ARROW_DOWN); // move to the ready-for-agent 020-build
    await tick();
    stdin.write("m");
    await tick();

    expect(markDone.readMarkDone).not.toHaveBeenCalled();
  });

  it("does nothing on m when no markDone seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={humanBoard} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("m");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("ready-for-human → done");
  });

  it("writes status done to the Issue path on confirm, then closes with a notice", async () => {
    const markDone = spyMarkDone();
    const { stdin, lastFrame } = render(<App board={humanBoard} markDone={markDone} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("m"); // open the confirm preview
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(markDone.markDone).toHaveBeenCalledTimes(1);
    expect(markDone.markDone).toHaveBeenCalledWith(previewFor("010-secret"));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("ready-for-human → done"); // modal closed
    expect(frame).toContain("done"); // success notice
  });

  it("cancels on Esc with nothing written", async () => {
    const markDone = spyMarkDone();
    const { stdin, lastFrame } = render(<App board={humanBoard} markDone={markDone} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("m");
    await tick();
    stdin.write(ESC); // cancel
    await tick();

    expect(markDone.markDone).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("ready-for-human → done");
  });
});

describe("App approve (A on a human-review Issue)", () => {
  // A board whose selected (first) Issue is an approvable `human-review` card — the
  // only state `A` lights up on (lane human-review + the `approvable` overlay set by
  // the scanner on a recorded worktree+branch). A second non-approvable human-review
  // card pins the eligibility gate.
  const reviewBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [
          {
            id: "010-merge-me",
            title: "Merge me",
            lane: "human-review",
            humanReviewReason: "deviation",
            approvable: true,
          },
          {
            id: "020-no-handoff",
            title: "No handoff",
            lane: "human-review",
            humanReviewReason: "non-convergence",
          },
        ],
      },
    ],
  };

  function previewFor(issueId: string): ApprovePreviewData {
    return {
      issueTitle: issueId,
      issuePath: `/root/auth/${issueId}`,
      repo: "/repos/backend",
      worktree: "/wt/blue-cat-fox",
      branch: "blue-cat-fox",
      featureBranch: "auth",
    };
  }

  function spyApprove(
    result: ApproveResult = { kind: "merged" },
    readApprove: (prdId: string, issueId: string) => ApprovePreviewData | undefined = (
      _p,
      id,
    ) => previewFor(id),
  ) {
    return {
      readApprove: vi.fn(readApprove),
      approve: vi.fn<(p: ApprovePreviewData) => ApproveResult>(() => result),
    };
  }

  it("opens a confirm preview on A at the Issue level for an approvable human-review Issue", async () => {
    const approve = spyApprove();
    const { stdin, lastFrame } = render(<App board={reviewBoard} approve={approve} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues (selects 010-merge-me)
    await tick();
    stdin.write("A");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Approve"); // the preview titles the action
    expect(frame).toContain("blue-cat-fox"); // names the branch
    expect(frame).toContain("auth"); // names the feature branch + plan
    expect(frame).not.toContain("diff"); // states the plan only — no diff
    expect(approve.readApprove).toHaveBeenCalledWith("auth", "010-merge-me");
  });

  it("does nothing on A at the board level (approve is Issue-level only)", async () => {
    const approve = spyApprove();
    const { stdin } = render(<App board={reviewBoard} approve={approve} />);

    stdin.write("A");
    await tick();

    expect(approve.readApprove).not.toHaveBeenCalled();
  });

  it("does nothing on A for a human-review Issue with no recorded handoff", async () => {
    const approve = spyApprove();
    const { stdin } = render(<App board={reviewBoard} approve={approve} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write(ARROW_DOWN); // move to 020-no-handoff (not approvable)
    await tick();
    stdin.write("A");
    await tick();

    expect(approve.readApprove).not.toHaveBeenCalled();
  });

  it("does nothing on A when no approve seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={reviewBoard} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("A");
    await tick();

    // The modal never opens — its affordance line is the modal-only surface (the
    // status-line hint and the card title are separate surfaces that legitimately
    // show regardless of whether a seam is wired).
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("y to approve");
  });

  it("on confirm of a clean merge, invokes the seam and moves the card via re-scan", async () => {
    const approve = spyApprove({ kind: "merged" });
    const refresh = vi.fn();
    const { stdin, lastFrame } = render(
      <App board={reviewBoard} approve={approve} refresh={refresh} />,
    );

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("A"); // open the confirm preview
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(approve.approve).toHaveBeenCalledTimes(1);
    expect(approve.approve).toHaveBeenCalledWith(previewFor("010-merge-me"));
    // A merged result re-scans so the card moves to done at once (the live re-scan).
    expect(refresh).toHaveBeenCalled();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("y to approve"); // modal closed (its affordance gone)
    expect(frame.toLowerCase()).toContain("merged"); // success notice
  });

  it("surfaces a loud message and leaves the card put on a dirty worktree", async () => {
    const approve = spyApprove({ kind: "dirty" });
    const refresh = vi.fn();
    const { stdin, lastFrame } = render(
      <App board={reviewBoard} approve={approve} refresh={refresh} />,
    );

    stdin.write(ENTER);
    await tick();
    stdin.write("A");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(approve.approve).toHaveBeenCalledTimes(1);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toContain("commit"); // "commit your fix first"
    // No move: a dirty result must not re-scan a card into done.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces a loud message and leaves the card put on a conflict", async () => {
    const approve = spyApprove({ kind: "conflict" });
    const { stdin, lastFrame } = render(<App board={reviewBoard} approve={approve} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("A");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(approve.approve).toHaveBeenCalledTimes(1);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toContain("conflict"); // "resolve the conflict in the worktree first"
    expect(frame).toContain("worktree");
  });

  it("cancels on Esc with nothing merged", async () => {
    const approve = spyApprove();
    const { stdin, lastFrame } = render(<App board={reviewBoard} approve={approve} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("A");
    await tick();
    stdin.write(ESC); // cancel
    await tick();

    expect(approve.approve).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("y to approve");
  });
});

describe("App re-dispatch (R on an orphan)", () => {
  // A board whose first PRD's first Issue is an orphaned in-progress card.
  const orphanBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [
          { id: "010-login", title: "Login", lane: "in-progress", liveness: "orphaned" },
          { id: "020-oauth", title: "OAuth", lane: "in-progress", liveness: "live" },
        ],
      },
    ],
  };

  function preview(id: string): RedispatchPreviewData {
    return {
      prdId: "auth",
      issueId: id,
      issue: {
        id,
        title: id,
        path: `/root/auth/${id}`,
        status: "in-progress",
        blockedBy: [],
        repo: "/r",
        worktree: undefined,
        branch: undefined,
        deviation: undefined,
        reviewVerdict: undefined,
        slice: undefined,
        reviewFindings: undefined,
        reviewTolerated: undefined,
        body: "",
      },
    };
  }

  function spyRollback(
    rollback: (p: RedispatchPreviewData) => RollbackOutcome = () => "rolled-back",
    readRollback: (
      prdId: string,
      issueId: string,
    ) => RedispatchPreviewData | undefined = (_p, id) => preview(id),
  ) {
    return {
      readRollback: vi.fn(readRollback),
      rollback: vi.fn(rollback),
    };
  }

  it("opens a re-dispatch preview on R for the selected orphan", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues; first Issue is the orphan
    await tick();
    stdin.write("R");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Re-dispatch 010-login");
    expect(rollback.readRollback).toHaveBeenCalledWith("auth", "010-login");
  });

  it("rolls the orphan back on confirm, then closes the modal", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(rollback.rollback).toHaveBeenCalledTimes(1);
    expect(rollback.rollback).toHaveBeenCalledWith(preview("010-login"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch 010-login");
    // A real recovery surfaces a confirmation notice on the status line.
    expect(stripAnsi(lastFrame() ?? "")).toContain("Rolled 010-login back");
  });

  it("surfaces a 'nothing to recover' notice when the orphan already advanced", async () => {
    // The agent wasn't actually dead: by confirm the on-disk status advanced, so
    // `rollback` re-reads it and returns `advanced` — the confirm must not look
    // like a silent no-op (ADR 0009).
    const rollback = spyRollback(() => "advanced");
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("already advanced");
    expect(frame).not.toContain("Re-dispatch 010-login"); // modal closed
  });

  it("clears the rollback notice on the next keypress", async () => {
    const rollback = spyRollback(() => "rolled-back");
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();
    stdin.write(ENTER); // confirm → notice shown
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Rolled 010-login back");

    stdin.write(ARROW_DOWN); // any keypress dismisses the one-shot notice
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Rolled 010-login back");
  });

  it("cancels the re-dispatch on Esc, leaving the orphan untouched", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(rollback.rollback).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch 010-login");
  });

  it("is a no-op on R for a non-orphan card", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write(ENTER); // zoom in (first Issue is the orphan)
    await tick();
    stdin.write(ARROW_DOWN); // move to the live (non-orphan) second Issue
    await tick();
    stdin.write("R");
    await tick();

    expect(rollback.readRollback).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch 010-login");
  });

  it("does nothing on R at the board level (recovery is Issue-level only)", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write("R"); // at board level, no zoom
    await tick();

    expect(rollback.readRollback).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch 010-login");
  });

  it("does nothing on R when no rollback seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={orphanBoard} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch 010-login");
  });
});

// Shared fixture for kill and agent-output tests: a board with one orphaned and one
// live Issue, and a helper to navigate to the live card.
const liveCardBoard: Board = {
  prds: [
    {
      id: "auth",
      title: "AuthPRD",
      lane: "in-progress",
      issues: [
        { id: "010-login", title: "Login", lane: "in-progress", liveness: "orphaned" },
        { id: "020-oauth", title: "OAuth", lane: "in-progress", liveness: "live" },
      ],
    },
  ],
};

/** Zoom in and move the cursor to the live second Issue (020-oauth). */
async function selectLiveCard(stdin: { write: (s: string) => void }) {
  stdin.write(ENTER); // zoom into AuthPRD's Issues
  await tick();
  stdin.write(ARROW_DOWN); // first Issue is the orphan; move to the live one
  await tick();
}

describe("App kill (K on a live card)", () => {
  const orphanBoard = liveCardBoard;

  function killPreview(id: string): KillPreviewData {
    return {
      prdId: "auth",
      issueId: id,
      handle: "17f1797e",
      issue: {
        id,
        title: id,
        path: `/root/auth/${id}`,
        status: "in-progress",
        blockedBy: [],
        repo: "/r",
        worktree: undefined,
        branch: undefined,
        deviation: undefined,
        reviewVerdict: undefined,
        slice: undefined,
        reviewFindings: undefined,
        reviewTolerated: undefined,
        body: "",
      },
    };
  }

  function spyKiller(
    kill: (p: KillPreviewData) => KillOutcome = () => "stopped",
    readKill: (
      prdId: string,
      issueId: string,
    ) => KillPreviewData | undefined = (_p, id) => killPreview(id),
  ) {
    return {
      readKill: vi.fn(readKill),
      kill: vi.fn(kill),
    };
  }

  it("opens a kill preview on K for the selected live Issue", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Stop 020-oauth's agent");
    expect(killer.readKill).toHaveBeenCalledWith("auth", "020-oauth");
  });

  it("stops the agent on confirm, then closes the modal with a notice", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(killer.kill).toHaveBeenCalledTimes(1);
    expect(killer.kill).toHaveBeenCalledWith(killPreview("020-oauth"));
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 020-oauth");
    expect(stripAnsi(lastFrame() ?? "")).toContain("Stopped 020-oauth");
  });

  it("surfaces a 'no longer running' notice when the agent had already gone", async () => {
    const killer = spyKiller(() => "not-running");
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("no longer running");
  });

  it("surfaces an 'uncertain' notice when the stop could not be confirmed", async () => {
    const killer = spyKiller(() => "uncertain");
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("Couldn't confirm");
  });

  it("surfaces an 'unavailable' notice when claude could not be launched", async () => {
    const killer = spyKiller(() => "unavailable");
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("claude CLI on your PATH");
  });

  it("notices (not silently no-ops) when a live card has no recorded handle", async () => {
    // The verdict/sidecar race: the card reads `live` but readKill finds no
    // handle. Without feedback K would look broken, so it must say so.
    const killer = spyKiller(undefined, () => undefined);
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();

    expect(killer.kill).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 020-oauth"); // no modal
    expect(stripAnsi(lastFrame() ?? "")).toContain("no recorded agent to stop");
  });

  it("clears the kill notice on the next keypress", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER); // confirm → notice shown
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Stopped 020-oauth");

    stdin.write(ARROW_DOWN); // any keypress dismisses the one-shot notice
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stopped 020-oauth");
  });

  it("cancels the kill on Esc, leaving the agent untouched", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLiveCard(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(killer.kill).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 020-oauth");
  });

  it("is a no-op on K for a non-live card", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    stdin.write(ENTER); // zoom in; first Issue is the *orphan* (not live)
    await tick();
    stdin.write("K");
    await tick();

    expect(killer.readKill).not.toHaveBeenCalled();
    // The kill preview for the (orphaned) selected card never opens.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 010-login");
  });

  it("does nothing on K at the board level (kill is Issue-level only)", async () => {
    const killer = spyKiller();
    const { stdin } = render(<App board={orphanBoard} killer={killer} />);

    stdin.write("K"); // at board level, no zoom
    await tick();

    expect(killer.readKill).not.toHaveBeenCalled();
  });

  it("does nothing on K when no killer seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={orphanBoard} />);

    stdin.write(ENTER);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("K");
    await tick();

    // No killer seam ⇒ the kill preview for the live card never opens (the bar may
    // still offer the K hint, which is the registry label, not this preview header).
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 020-oauth");
  });
});

describe("App agent output (o on a live card)", () => {
  // Uses the shared liveCardBoard / selectLiveCard fixture defined above the kill block.
  const orphanBoard = liveCardBoard;

  const DEFAULT_OUTPUT: AgentOutput = { title: "OAuth", output: "running tests…\n" };

  /** An output reader resolving fixed output for any Issue; the spy records the call. */
  function spyOutputReader(output: AgentOutput = DEFAULT_OUTPUT) {
    return {
      readAgentOutput: vi.fn<
        (prdId: string, issueId: string) => AgentOutput | undefined
      >(() => output),
    };
  }

  it("opens the agent-output modal on o for the selected live Issue", async () => {
    const reader = spyOutputReader({ title: "OAuth", output: "compiling…\nlinking…\n" });
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();

    expect(reader.readAgentOutput).toHaveBeenCalledWith("auth", "020-oauth");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("OAuth"); // the modal title
    expect(frame).toContain("compiling…"); // the agent's output
    expect(frame).toContain("to close"); // the close/scroll hint
  });

  it("scrolls the output on j (a snapshot taller than the viewport)", async () => {
    // Taller than the test viewport (renderForTest defaults to 200 rows minus the
    // modal chrome), so the first line genuinely scrolls off as `j` advances.
    const tall = Array.from({ length: 300 }, (_, i) => `OUTLINE${i}`).join("\n");
    const reader = spyOutputReader({ title: "OAuth", output: tall });
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("OUTLINE0"); // top visible at first
    // Scroll down several lines, then assert the top line has scrolled off.
    for (let i = 0; i < 5; i++) {
      stdin.write("j");
      await tick();
    }
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("OUTLINE0"); // first line scrolled off
  });

  it("flashes a status-line notice (and opens no modal) when a live card has no handle", async () => {
    // The verdict/sidecar race: the card reads `live` but readAgentOutput finds no
    // recorded handle. Without feedback `o` would look broken, so it must say so —
    // exactly as Kill does in the same race.
    const reader = {
      readAgentOutput: vi.fn<
        (prdId: string, issueId: string) => AgentOutput | undefined
      >(() => undefined),
    };
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("to close"); // no modal opened
    expect(frame).toContain("no recorded agent"); // the legible notice
  });

  it("closes the modal on o (toggle) and restores the zoom", async () => {
    const reader = spyOutputReader();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o"); // open
    await tick();
    stdin.write("o"); // close
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("to close"); // modal gone
    expect(frame).toContain("OAuth"); // still zoomed on the Issue card
  });

  it("closes the modal on Esc", async () => {
    const reader = spyOutputReader();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("to close");
  });

  it("quits on q from the modal", async () => {
    const reader = spyOutputReader();
    const { stdin, frames } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();
    stdin.write("q");
    await tick();
    const framesAfterQuit = frames.length;

    // The app unmounted: further input produces no new frame.
    stdin.write(ARROW_DOWN);
    await tick();
    expect(frames.length).toBe(framesAfterQuit);
  });

  it("is a no-op on o for a non-live card", async () => {
    const reader = spyOutputReader();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} />,
    );

    stdin.write(ENTER); // zoom in; first Issue is the *orphan* (not live)
    await tick();
    stdin.write("o");
    await tick();

    expect(reader.readAgentOutput).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("to close"); // no modal
  });

  it("does nothing on o at the board level (agent output is Issue-level only)", async () => {
    const reader = spyOutputReader();
    const { stdin } = render(<App board={orphanBoard} agentOutputReader={reader} />);

    stdin.write("o"); // at board level, no zoom
    await tick();

    expect(reader.readAgentOutput).not.toHaveBeenCalled();
  });

  it("does nothing on o when no output reader is wired", async () => {
    const { stdin, lastFrame } = render(<App board={orphanBoard} />);

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();

    // No reader seam ⇒ the output modal never opens; still on the Issue board.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("to close");
  });

  it("shows the o hint only on a live card", async () => {
    const { stdin, lastFrame } = render(<App board={orphanBoard} agentOutputReader={spyOutputReader()} />);

    stdin.write(ENTER); // zoom in; selection rests on the orphan first
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("o Read"); // not on the orphan

    stdin.write(ARROW_DOWN); // move to the live card
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("o Read"); // now the hint shows
  });

  it("runs the raw logs bytes through the injected renderer and shows its resolved lines", async () => {
    // The reader stays raw (returns `claude logs` bytes verbatim); the App feeds
    // those bytes through the terminal-emulator seam (ADR 0030) and renders the
    // *resolved* lines. Injecting a fake renderer proves the wiring: the raw redraw
    // stream is not shown, the emulator's screen is.
    const raw = "Progress: 10%\rProgress: 100%\n";
    const reader = spyOutputReader({ title: "OAuth", output: raw });
    const fakeRender = vi.fn<
      (bytes: string, cols: number, rows: number) => Promise<readonly string[]>
    >(async () => ["Progress: 100%"]);
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} renderTerminal={fakeRender} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();

    // The renderer received the raw bytes verbatim, sized to a positive grid.
    expect(fakeRender).toHaveBeenCalledTimes(1);
    const [bytes, cols, rows] = fakeRender.mock.calls[0]!;
    expect(bytes).toBe(raw);
    expect(cols).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("to close"); // the modal opened
    expect(frame).toContain("Progress: 100%"); // the resolved screen line
    expect(frame).not.toContain("Progress: 10%\r"); // not the raw redraw stream
  });

  it("shows the (no output yet) placeholder when the renderer resolves to no real content", async () => {
    // Empty / whitespace-only bytes resolve to no real content, so the placeholder
    // branch — keyed off the resolved lines — still fires (a just-spawned agent).
    const reader = spyOutputReader({ title: "OAuth", output: "   \n\n" });
    const fakeRender = vi.fn<
      (bytes: string, cols: number, rows: number) => Promise<readonly string[]>
    >(async () => []);
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} renderTerminal={fakeRender} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("to close"); // the modal still opened
    expect(frame).toContain("(no output yet)"); // ...onto the placeholder
  });

  it("discards a stale renderer resolution if the selection changes before it resolves", async () => {
    // The emulator flush is awaited (ADR 0030), so there is a real window between
    // pressing `o` and the modal opening. If the user moves off the live card
    // during that window, the eventual resolution must not pop the agent-output
    // modal open over whatever the user is now looking at.
    const reader = spyOutputReader({ title: "OAuth", output: "compiling…\n" });
    let resolveRender: ((lines: readonly string[]) => void) | undefined;
    const fakeRender = vi.fn<
      (bytes: string, cols: number, rows: number) => Promise<readonly string[]>
    >(() => new Promise((resolve) => (resolveRender = resolve)));
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} renderTerminal={fakeRender} />,
    );

    await selectLiveCard(stdin); // now on 020-oauth (live)
    stdin.write("o");
    await tick(); // the render is in flight, but not yet resolved

    stdin.write(ARROW_UP); // move to 010-login (the orphan) before it resolves
    await tick();

    resolveRender?.(["compiling…"]);
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("to close"); // the modal never opened
    expect(frame).not.toContain("compiling…"); // the stale output never rendered
  });

  it("discards an older in-flight request when a newer o press supersedes it", async () => {
    // Two quick `o` presses on the same card race two emulator flushes; only the
    // most recently started request may populate the modal, regardless of settle
    // order — otherwise a slow first flush could overwrite a fast second one.
    const reader = spyOutputReader({ title: "OAuth", output: "compiling…\n" });
    const resolvers: Array<(lines: readonly string[]) => void> = [];
    const fakeRender = vi.fn<
      (bytes: string, cols: number, rows: number) => Promise<readonly string[]>
    >(() => new Promise((resolve) => resolvers.push(resolve)));
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} agentOutputReader={reader} renderTerminal={fakeRender} />,
    );

    await selectLiveCard(stdin);
    stdin.write("o"); // first request
    await tick();
    stdin.write("o"); // second request supersedes the first — modal is still closed, so `o` reaches the handler again
    await tick();

    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(["second"]); // the newer request resolves first
    await tick();
    resolvers[0]?.(["first"]); // the older, superseded request resolves after

    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("second"); // the newer request's result won
    expect(frame).not.toContain("first"); // the stale older result was discarded
  });
});

describe("App go to PR (g on a done PRD)", () => {
  /** A board whose first PRD is `done` with an open PR, the second with no PR. */
  const prBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "done",
        issues: [{ id: "010-login", title: "Login", lane: "done" }],
        linkedPr: { state: "open", url: "https://github.com/o/r/pull/7" },
      },
      {
        id: "billing",
        title: "BillPRD",
        lane: "done",
        issues: [{ id: "010-invoice", title: "Invoice", lane: "done" }],
      },
    ],
  };

  /** A board with one `done` PRD whose PR is merged. */
  const mergedBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "done",
        issues: [{ id: "010-login", title: "Login", lane: "done" }],
        linkedPr: { state: "merged", url: "https://github.com/o/r/pull/9" },
      },
    ],
  };

  /** A URL opener whose open method is a spy. */
  function spyOpener() {
    return { open: vi.fn<(url: string) => void>() };
  }

  it("opens the selected PRD's PR url on g when its overlay reports an open PR", async () => {
    const opener = spyOpener();
    const { stdin } = render(<App board={prBoard} urlOpener={opener} />);

    stdin.write("g");
    await tick();

    expect(opener.open).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
  });

  it("opens the PR url for a merged PR too (a merged PR's discussion stays reachable)", async () => {
    const opener = spyOpener();
    const { stdin } = render(<App board={mergedBoard} urlOpener={opener} />);

    stdin.write("g");
    await tick();

    expect(opener.open).toHaveBeenCalledWith("https://github.com/o/r/pull/9");
  });

  it("opens the bottom PR on g for a stacked PRD (the stack's entry point)", async () => {
    // A stacked PRD's overlay carries the bottom PR (slice 1) as its url, so `go to
    // PR` opens the one a human merges first (ADR 0025) — not an upper slice.
    const opener = spyOpener();
    const stackedBoard: Board = {
      prds: [
        {
          id: "stacked",
          title: "StackedPRD",
          lane: "done",
          issues: [{ id: "010-schema", title: "Schema", lane: "done" }],
          linkedPr: {
            state: "open",
            url: "https://github.com/o/r/pull/41", // the bottom PR (slice 1)
            stack: { merged: 1, total: 3 },
          },
        },
      ],
    };
    const { stdin } = render(<App board={stackedBoard} urlOpener={opener} />);

    stdin.write("g");
    await tick();

    expect(opener.open).toHaveBeenCalledWith("https://github.com/o/r/pull/41");
  });

  it("is genuinely inert on a done PRD with no linked PR (g unbound there — P owns that card)", async () => {
    // Eligibility makes `g` mutually exclusive with `P`: on a `done` PRD with no
    // Linked PR, `g` is not bound at all (ADR 0017), so pressing it does nothing —
    // no open, and no 'no PR' flash (that handler no-op guard is now the matcher's
    // inertness; `P` is the key that lights up on a no-PR done PRD).
    const opener = spyOpener();
    const { stdin, lastFrame } = render(<App board={prBoard} urlOpener={opener} />);

    stdin.write(ARROW_DOWN); // move to BillPRD, which has no linked PR
    await tick();
    stdin.write("g");
    await tick();

    expect(opener.open).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("no PR");
  });

  it("does nothing on g at the Issue level (go to PR is board-level only)", async () => {
    const opener = spyOpener();
    const { stdin } = render(<App board={prBoard} urlOpener={opener} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("g");
    await tick();

    expect(opener.open).not.toHaveBeenCalled();
  });

  it("does nothing on g when no url opener is wired", async () => {
    // No opener seam: the keybind degrades to a silent no-op rather than crashing.
    const { stdin, lastFrame } = render(<App board={prBoard} />);

    stdin.write("g");
    await tick();

    // The board is still up and unchanged (no crash, no notice).
    expect(stripAnsi(lastFrame() ?? "")).toContain("AuthPRD");
  });

});


describe("App open PR (P on a done PRD)", () => {
  // A board whose first PRD is `done` (the only column Open PR is offered on) and
  // whose second is in-progress, so we can assert the `done` gate.
  const doneBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "done",
        issues: [{ id: "010-login", title: "Login", lane: "done" }],
      },
      {
        id: "billing",
        title: "BillPRD",
        lane: "in-progress",
        issues: [{ id: "010-invoice", title: "Invoice", lane: "in-progress" }],
      },
    ],
  };

  function eligiblePreview(prdId: string): OpenPrPreviewData {
    return {
      prdTitle: prdId,
      branch: `${prdId}-branch`,
      base: "origin/main",
      eligibility: { canOpen: true },
    };
  }

  function refusedPreview(prdId: string, reason: string): OpenPrPreviewData {
    return {
      prdTitle: prdId,
      branch: `${prdId}-branch`,
      base: "origin/main",
      eligibility: { canOpen: false, reason },
    };
  }

  function spyOpenPr(
    openPr: (p: OpenPrPreviewData) => OpenPrResult = () => ({
      ok: true,
      url: "https://gh/pr/new",
    }),
    readOpenPr: (prdId: string) => OpenPrPreviewData | undefined = (id) =>
      eligiblePreview(id),
  ) {
    return {
      readOpenPr: vi.fn(readOpenPr),
      openPr: vi.fn(openPr),
    };
  }

  it("opens a confirm preview on P at the board level for a done PRD", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // move right from the in-progress BillPRD to the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    // Both outward actions are previewed: push the branch, open the PR into base.
    expect(frame).toContain("Open PR");
    expect(frame).toContain("auth-branch");
    expect(frame).toContain("origin/main");
    expect(opener.readOpenPr).toHaveBeenCalledWith("auth");
  });

  it("does nothing on P for a non-done PRD (the action is done-gated)", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_DOWN); // move to the in-progress BillPRD
    await tick();
    stdin.write("P");
    await tick();

    expect(opener.readOpenPr).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Open PR");
  });

  it("does nothing on P at the issue (zoomed) level", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("P");
    await tick();

    expect(opener.readOpenPr).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Open PR");
  });

  it("pushes and creates on confirm, then closes the modal with a success notice", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(opener.openPr).toHaveBeenCalledTimes(1);
    expect(opener.openPr).toHaveBeenCalledWith(eligiblePreview("auth"));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("Open PR"); // modal closed
    expect(frame).toContain("https://gh/pr/new"); // the new PR url surfaced
  });

  it("re-scans the board after a successful open so eligibility re-resolves (issue #66)", async () => {
    // Opening a PR is a GitHub write that fires no FS event, so the watcher never
    // re-scans — the App must call `refresh` itself so the new PR shows and the
    // PRD's Open PR eligibility flips off, rather than the board staying stale.
    const opener = spyOpenPr();
    const refresh = vi.fn();
    const { stdin } = render(
      <App board={doneBoard} openPr={opener} refresh={refresh} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not re-scan after a failed open (nothing changed on GitHub)", async () => {
    const opener = spyOpenPr(() => ({ ok: false, error: "gh: not authenticated" }));
    const refresh = vi.fn();
    const { stdin } = render(
      <App board={doneBoard} openPr={opener} refresh={refresh} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces a gh/git failure loudly in the status line, opening no PR notice", async () => {
    const opener = spyOpenPr(() => ({ ok: false, error: "gh: not authenticated" }));
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("not authenticated");
  });

  it("shows the refusal in the preview for a multi-repo PRD, confirming opens nothing", async () => {
    const opener = spyOpenPr(undefined, (id) =>
      refusedPreview(id, "this PRD spans 2 repos — open a PR per repo manually"),
    );
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("spans 2 repos");

    // Confirming a refused preview opens no PR — there is nothing to confirm.
    stdin.write(ENTER);
    await tick();
    expect(opener.openPr).not.toHaveBeenCalled();
  });

  it("shows the refusal for a branch that already has a PR (no duplicate)", async () => {
    const opener = spyOpenPr(undefined, (id) =>
      refusedPreview(id, "a PR already exists for this branch"),
    );
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("already exists");
  });

  it("cancels on Esc without opening a PR", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write("P");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(opener.openPr).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Open PR");
  });

  it("clears the open-PR notice on the next keypress", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P");
    await tick();
    stdin.write(ENTER); // confirm → notice shown
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("https://gh/pr/new");

    stdin.write(ARROW_DOWN); // any keypress dismisses the one-shot notice
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("https://gh/pr/new");
  });

  it("does nothing on P when no openPr seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={doneBoard} />);

    stdin.write("P");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Open PR");
  });

  it("keeps the modal labelled from the open-time capture if a re-scan removes its PRD", async () => {
    const opener = spyOpenPr();
    const { stdin, lastFrame, rerender } = render(
      <App board={doneBoard} openPr={opener} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("P"); // open the preview on AuthPRD (done)
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("auth-branch");

    // A live re-scan removes AuthPRD from under the open modal.
    const withoutAuth: Board = {
      prds: doneBoard.prds.filter((p) => p.id !== "auth"),
    };
    rerender(<App board={withoutAuth} openPr={opener} />);
    await tick();

    // Still labelled from the frozen capture, and a confirm acts on AuthPRD's PR.
    expect(stripAnsi(lastFrame() ?? "")).toContain("auth-branch");
    stdin.write(ENTER);
    await tick();
    expect(opener.openPr).toHaveBeenCalledWith(eligiblePreview("auth"));
  });
});


describe("App delete PRD (X on a done PRD)", () => {
  // A board whose first PRD is `done` (the only column Delete is offered on) and
  // whose second is in-progress, so we can assert the `done` gate.
  const doneBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "done",
        issues: [{ id: "010-login", title: "Login", lane: "done" }],
      },
      {
        id: "billing",
        title: "BillPRD",
        lane: "in-progress",
        issues: [{ id: "010-invoice", title: "Invoice", lane: "in-progress" }],
      },
    ],
  };

  function previewFor(prdId: string): DeletePreviewData {
    return { prdTitle: prdId, issueCount: 2 };
  }

  function spyDeleter(
    del: (p: DeletePreviewData) => DeleteResult = () => ({ ok: true }),
    readDelete: (prdId: string) => DeletePreviewData | undefined = (id) =>
      previewFor(id),
  ) {
    return {
      readDelete: vi.fn(readDelete),
      delete: vi.fn(del),
    };
  }

  it("opens a confirm preview on X at the board level for a done PRD", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_RIGHT); // move from the in-progress BillPRD to the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Delete");
    expect(frame).toContain("auth"); // the preview names the PRD
    expect(deleter.readDelete).toHaveBeenCalledWith("auth");
  });

  it("does nothing on X for a non-done PRD (the action is done-gated)", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_DOWN); // move to the in-progress BillPRD
    await tick();
    stdin.write("X");
    await tick();

    expect(deleter.readDelete).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("permanent");
  });

  it("does nothing on X at the issue (zoomed) level", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ENTER); // zoom in
    await tick();
    stdin.write("X");
    await tick();

    expect(deleter.readDelete).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("permanent");
  });

  it("does nothing on X when no deleter seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={doneBoard} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("permanent");
  });

  it("removes the directory on confirm, then closes the modal with a success notice", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(deleter.delete).toHaveBeenCalledTimes(1);
    expect(deleter.delete).toHaveBeenCalledWith(previewFor("auth"));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("permanent"); // modal closed
    expect(frame).toContain("Deleted"); // success notice
  });

  it("re-scans the board after a successful delete so the card disappears at once", async () => {
    const deleter = spyDeleter();
    const refresh = vi.fn();
    const { stdin } = render(
      <App board={doneBoard} deleter={deleter} refresh={refresh} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not re-scan after a failed delete (nothing was removed)", async () => {
    const deleter = spyDeleter(() => ({ ok: false, error: "EACCES" }));
    const refresh = vi.fn();
    const { stdin } = render(
      <App board={doneBoard} deleter={deleter} refresh={refresh} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces a removal failure loudly in the status line, deleting no card", async () => {
    const deleter = spyDeleter(() => ({
      ok: false,
      error: "EACCES: permission denied",
    }));
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ENTER); // confirm
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("Couldn't delete");
  });

  it("cancels on Esc with nothing deleted", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(deleter.delete).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("permanent");
  });

  it("keeps the modal labelled from the open-time capture if a re-scan removes its PRD", async () => {
    const deleter = spyDeleter();
    const { stdin, lastFrame, rerender } = render(
      <App board={doneBoard} deleter={deleter} />,
    );

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X"); // open the preview on AuthPRD (done)
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("auth");

    // A live re-scan removes AuthPRD from under the open modal.
    const withoutAuth: Board = {
      prds: doneBoard.prds.filter((p) => p.id !== "auth"),
    };
    rerender(<App board={withoutAuth} deleter={deleter} />);
    await tick();

    // Still labelled from the frozen capture, and a confirm acts on AuthPRD.
    expect(stripAnsi(lastFrame() ?? "")).toContain("auth");
    stdin.write(ENTER);
    await tick();
    expect(deleter.delete).toHaveBeenCalledWith(previewFor("auth"));
  });

  it("surfaces the failure notice rather than throwing when the directory vanished under the modal (real seam, total by construction)", async () => {
    // The spy tests above hand the App a canned `DeleteResult`; this one drives the
    // *real* `createDelete` orchestration end-to-end so the total-by-construction
    // guarantee is exercised through the App, not just unit-tested. The directory
    // the preview was frozen on has vanished (or its removal is forbidden) by the
    // time the user confirms, so the injected `removeDir` throws. The orchestration
    // must catch it and hand the App a failed result — surfacing the loud status-
    // line notice — never letting the throw escape the Ink input handler and crash
    // the board (mirroring the Open PR end-to-end failure path).
    const deleter = createDelete("/root", {
      seam: {
        removeDir: () => {
          throw new Error("ENOENT: no such file or directory");
        },
      },
      countIssues: () => 2,
    });
    const { stdin, lastFrame } = render(<App board={doneBoard} deleter={deleter} />);

    stdin.write(ARROW_RIGHT); // select the done AuthPRD
    await tick();
    stdin.write("X"); // open the preview (frozen on AuthPRD)
    await tick();
    stdin.write(ENTER); // confirm — the removal throws under the modal
    await tick();

    // The throw was caught and degraded to a loud notice; the board still renders.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Couldn't delete");
    expect(frame).toContain("ENOENT");
  });
});


describe("App full screen", () => {
  /** Count the rendered rows in a frame (Ink emits one line per terminal row). */
  const rowCount = (frame: string): number => frame.split("\n").length;

  it("fills the viewport height, padding a short board to the terminal rows", () => {
    // A short board (two PRDs) in a 30-row terminal. Inline rendering would emit
    // only as many rows as the content needs; full-screen fills to the viewport.
    const { lastFrame } = render(<App board={board} />, 240, 30);

    expect(rowCount(stripAnsi(lastFrame() ?? ""))).toBe(30);
  });

  it("pins the status line to the bottom row, below the board content", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={{ enabled: true, toggle: () => {} }} />,
      240,
      30,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");

    // The status line sits on the last row, pushed down by the spacer; the board
    // content is above it (the first PRD card is in the top half).
    expect(lines[lines.length - 1]).toContain("auto-run on");
    const authRow = lines.findIndex((l) => l.includes("AuthPRD"));
    expect(authRow).toBeGreaterThanOrEqual(0);
    expect(authRow).toBeLessThan(lines.length - 1);
  });

  it("keeps the status line on screen when the board overflows the viewport", () => {
    // Many PRDs in a short terminal: content alone exceeds the rows. The status
    // line must clip the *board*, not itself — the auto-run indicator has to stay
    // legible however tall the board gets (ADR 0007), so it must never be the
    // thing pushed off the bottom edge.
    const tall: Board = {
      prds: Array.from({ length: 40 }, (_, i) => ({
        id: `p${i}`,
        title: `PRD${i}`,
        lane: "backlog" as const,
        issues: [],
      })),
    };
    const { lastFrame } = render(
      <App board={tall} autoRun={{ enabled: true, toggle: () => {} }} />,
      80,
      10,
    );
    const frame = stripAnsi(lastFrame() ?? "");

    expect(frame).toContain("auto-run on");
    expect(frame).toContain("? Show this help");
  });
});

describe("App help", () => {
  it("opens the help modal on ? at the board level", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Keybindings");
  });

  // The former "lists every keybind the input handler implements" drift-guard
  // test lived here only because the help modal was a hand-maintained second copy
  // of App's bindings. With the central `keybinds` registry now the single source
  // both consume, that property is structural — guaranteed by construction, not by
  // assertion. The registry's exhaustive key↔level↔label coverage lives in
  // keybinds.test.ts; the test below proves the modal renders *from* the registry.

  it("renders the help modal straight from the keybind registry", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    // Every registry entry's key and label appears, proving the modal reads the
    // registry rather than a separate hand-maintained array. If a row were dropped
    // from the modal, or the registry diverged from what the handler dispatches
    // off, this — together with keybinds.test.ts — would catch it.
    for (const b of KEYBINDS) {
      expect(frame).toContain(b.key);
      expect(frame).toContain(b.label);
    }
    // The context labels that tell you where each key works.
    expect(frame).toContain("(board)");
    expect(frame).toContain("(issues)");
    expect(frame).toContain("(both)");
  });

  it("opens the help modal on ? at the Issue level too", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("?");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("Keybindings");
  });

  it("ignores ? while a dispatch preview is open (no modal stacking)", async () => {
    const dispatcher = {
      // A spawn candidate makes the selected PRD dispatchable, so `d` is eligible
      // and opens the preview — the modal these tests then prove swallows the next key.
      readFrontier: vi.fn(
        () =>
          [{ issue: { id: "001.md" } as DispatchIssue, classification: "spawn" }] as readonly FrontierEntry[],
      ),
      hasDispatchable: vi.fn(() => true),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => DispatchResult>(() => ({
        launched: 1,
        skipped: 0,
      })),
    };
    const { stdin, lastFrame } = render(
      <App board={board} dispatcher={dispatcher} />,
    );

    stdin.write("d"); // open the dispatch preview
    await tick();
    stdin.write("?"); // swallowed by the preview — must not stack help over it
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Dispatch");
    expect(frame).not.toContain("Keybindings");
  });

  it("closes the help modal on ? (toggle off)", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?"); // open
    await tick();
    stdin.write("?"); // toggle closed
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("Keybindings");
    expect(frame).toContain("AuthPRD"); // back on the board
  });

  it("closes the help modal on Esc", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();
    stdin.write(ESC);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Keybindings");
  });

  it("closes the help modal and quits on q", async () => {
    const { stdin, frames, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();
    stdin.write("q"); // q closes help AND quits everywhere
    await tick();

    // Help is gone and the app unmounted: further input produces no new frame.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Keybindings");
    const framesAfterQuit = frames.length;
    stdin.write(ARROW_DOWN);
    await tick();
    expect(frames.length).toBe(framesAfterQuit);
  });

  it("swallows other keys while help is open (no leak to the board)", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?"); // open help on AuthPRD (first card)
    await tick();
    stdin.write(ARROW_DOWN); // would move selection if it leaked through
    await tick();
    stdin.write(ENTER); // would zoom if it leaked through
    await tick();
    stdin.write("?"); // close help
    await tick();

    // Selection never moved and we never zoomed: still board level, still AuthPRD.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("BillPRD"); // still board level (not zoomed)
    expect(frame).not.toContain("Login"); // never zoomed into Issues
  });

  it("shows the ? help hint on the status line even with no auto-run wired", () => {
    // The hint's discoverability must not depend on the auto-run seam — it shows
    // whenever the board is up, at both levels (the status line is shared).
    const { lastFrame } = render(<App board={board} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("? Show this help");
  });

  it("overlays the help on the board (board still visible) rather than replacing it", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    // Help is up...
    expect(frame).toContain("Keybindings");
    // ...but the board behind it is still rendered (not a screen takeover): the
    // selected PRD's card is still on screen so the user keeps their place.
    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("BillPRD");
  });

  it("preserves the zoomed Issue level behind the help overlay", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("?");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Keybindings");
    // Still zoomed into the Issues behind the overlay — the place is preserved.
    expect(frame).toContain("Login");
  });
});

describe("App bottom-row keybind hints — eligibility-driven (ADR 0017)", () => {
  // The bottom bar no longer renders a hardcoded list: it renders the registry
  // filtered through each binding's `eligible` predicate at the current level +
  // selection (the same predicate the matcher gates on). So it shows *only* the
  // keys actionable on the selected card — they appear and vanish as the selection
  // moves and as a card's state changes underneath it. Each hint reads its `key`
  // and registry `label` from the single source. `?` is always present.

  /** A dispatcher whose frontier presence is a spy, defaulting to dispatchable. */
  function spyDispatcher(dispatchable = true) {
    return {
      readFrontier: vi.fn(() => []),
      dispatch: vi.fn(),
      hasDispatchable: vi.fn(() => dispatchable),
    };
  }

  /** A done PRD with no PR, then a done PRD with an open PR. */
  const doneBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "done",
        issues: [{ id: "010-login", title: "Login", lane: "done" }],
      },
      {
        id: "billing",
        title: "BillPRD",
        lane: "done",
        issues: [{ id: "010-invoice", title: "Invoice", lane: "done" }],
        linkedPr: { state: "open", url: "https://github.com/o/r/pull/7" },
      },
    ],
  };

  /** A single in-progress PRD (its frontier presence comes from the dispatcher). */
  const inProgressBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [
          { id: "010-done", title: "Done", lane: "done" },
          { id: "020-oauth", title: "OAuth", lane: "ready", readyFor: "agent" },
        ],
      },
    ],
  };

  it("renders the hints from the registry, never the help modal, without opening help", () => {
    const { lastFrame } = render(
      <App board={inProgressBoard} dispatcher={spyDispatcher(true)} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // The bottom bar surfaces the dispatch binding's key + registry label, and the
    // always-on help pointer — without ever opening the modal. The board is
    // in-progress, so `d`'s context-aware hint label reads "Resume a wave".
    expect(frame).toContain("d");
    expect(frame).toContain("Resume a wave");
    expect(frame).toContain("? Show this help");
    expect(frame).not.toContain("Keybindings"); // help is not open
  });

  it("shows P and X but not d or g on a done PRD with no PR", () => {
    const { lastFrame } = render(<App board={doneBoard} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Open a PR for a done PRD"); // P
    expect(frame).toContain("Delete a done PRD"); // X
    expect(frame).not.toContain("Dispatch a wave"); // d hidden (not dispatchable)
    expect(frame).not.toContain("Go to the selected PRD's PR"); // g hidden (no PR)
  });

  it("shows go-to-PR and not Open-PR when the selection moves to a done PRD that has a PR", async () => {
    const { stdin, lastFrame } = render(<App board={doneBoard} />);

    // First card (AuthPRD, no PR) offers P, not g.
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Open a PR for a done PRD");
    expect(frame).not.toContain("Go to the selected PRD's PR");

    stdin.write(ARROW_DOWN); // move to BillPRD, which has an open PR
    await tick();

    // Moving the selection updates the hints to the new card's eligible keys.
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Go to the selected PRD's PR"); // g
    expect(frame).not.toContain("Open a PR for a done PRD"); // P gone
  });

  it("shows d (labelled 'resume') on an in-progress PRD with dispatchable frontier work", () => {
    // On an in-progress PRD `d` re-dispatches newly-unblocked work — the manual
    // resume crank — so its context-aware hint reads "Resume a wave", not "Dispatch".
    const { lastFrame } = render(
      <App board={inProgressBoard} dispatcher={spyDispatcher(true)} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Resume a wave");
    expect(frame).not.toContain("Dispatch a wave");
  });

  it("labels d 'dispatch' on a backlog PRD with dispatchable frontier work (first ignition)", () => {
    // The same key on a backlog PRD is first ignition, so its hint reads "Dispatch
    // a wave" — the dispatch/resume wording keys off the selected PRD's lane.
    const backlogBoard: Board = {
      prds: [
        {
          id: "auth",
          title: "AuthPRD",
          lane: "backlog",
          issues: [{ id: "010-login", title: "Login", lane: "ready", readyFor: "agent" }],
        },
      ],
    };
    const { lastFrame } = render(
      <App board={backlogBoard} dispatcher={spyDispatcher(true)} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Dispatch a wave");
    expect(frame).not.toContain("Resume a wave");
  });

  it("hides d entirely on a PRD whose frontier has no spawn candidate (empty wave never advertised)", () => {
    const { lastFrame } = render(
      <App board={inProgressBoard} dispatcher={spyDispatcher(false)} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Neither label surfaces: the binding is filtered out, not merely relabelled.
    expect(frame).not.toContain("Resume a wave");
    expect(frame).not.toContain("Dispatch a wave");
  });

  it("recomputes the hints when a card's state changes under the selection (PR opens)", async () => {
    // No selection move: a re-scan flips the selected done PRD from no-PR to
    // has-PR, and the bar must swap P for go-to-PR on its own.
    const donePrd = {
      id: "auth",
      title: "AuthPRD",
      lane: "done" as const,
      issues: [{ id: "010-login", title: "Login", lane: "done" as const }],
    };
    const noPr: Board = { prds: [donePrd] };
    const withPr: Board = {
      prds: [
        { ...donePrd, linkedPr: { state: "open", url: "https://github.com/o/r/pull/3" } },
      ],
    };
    const { rerender, lastFrame } = render(<App board={noPr} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Open a PR for a done PRD");

    rerender(<App board={withPr} />); // a live re-scan finds the PR
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Go to the selected PRD's PR");
    expect(frame).not.toContain("Open a PR for a done PRD");
  });

  it("offers the issue-level action keys only at the issue level, gated by state", async () => {
    const liveBoard: Board = {
      prds: [
        {
          id: "auth",
          title: "AuthPRD",
          lane: "in-progress",
          issues: [
            { id: "010-run", title: "Run", lane: "in-progress", liveness: "live" },
          ],
        },
      ],
    };
    const { stdin, lastFrame } = render(<App board={liveBoard} />);

    // At the board level, the issue-only keys are absent.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop a live Issue's agent");

    stdin.write(ENTER); // zoom into the Issues
    await tick();

    // The selected Issue is live, so K (kill) is offered.
    expect(stripAnsi(lastFrame() ?? "")).toContain("Stop a live Issue's agent");
  });

  it("always keeps the ? help pointer regardless of selection", async () => {
    // A backlog PRD with no dispatcher offers no action keys at all, but `?` stays.
    const { stdin, lastFrame } = render(<App board={board} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("? Show this help");

    stdin.write(ENTER); // zoom in — still no eligible action keys, ? remains
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("? Show this help");
  });

  it("separates the auto-run indicator from the keybind hints with spacing", () => {
    // The auto indicator and the help hint must read as distinct elements: with
    // both on the bar there is visible whitespace between them.
    const { lastFrame } = render(
      <App board={board} autoRun={{ enabled: true, toggle: () => {} }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    const barLine = frame.split("\n").find((l) => l.includes("auto-run on"));
    expect(barLine).toBeDefined();
    expect(barLine).toMatch(/auto-run on\s{2,}.*Show this help/);
  });
});

describe("App auto-run", () => {
  /** An auto-run seam whose toggle is a spy, defaulting to enabled. */
  function spyAutoRun(enabled = true) {
    return { enabled, toggle: vi.fn<() => void>() };
  }

  it("shows the auto-run-on indicator by default", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(true)} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("auto-run on");
  });

  it("shows the auto-run-off indicator when disabled", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(false)} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("auto-run off");
  });

  it("toggles auto-run on `a` at the board level", async () => {
    const autoRun = spyAutoRun();
    const { stdin } = render(<App board={board} autoRun={autoRun} />);

    stdin.write("a");
    await tick();

    expect(autoRun.toggle).toHaveBeenCalledTimes(1);
  });

  it("toggles auto-run on `a` at the Issue level too (it's a global switch)", async () => {
    const autoRun = spyAutoRun();
    const { stdin } = render(<App board={board} autoRun={autoRun} />);

    stdin.write(ENTER); // zoom into the PRD
    await tick();
    stdin.write("a");
    await tick();

    expect(autoRun.toggle).toHaveBeenCalledTimes(1);
  });

  it("shows the auto-run indicator and the ? help hint together", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(true)} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("auto-run on");
    expect(frame).toContain("? Show this help");
  });

  it("shows the stalled marker on a stalled PRD only when auto-run is off", () => {
    // A stalled PRD: derivePrdStalled would set `stalled` at scan time; here the
    // board is hand-built, so it carries the overlay directly. The marker is the
    // join of that overlay with the session auto-run state, so it must appear only
    // when the brake is on (the Reactor is not coming for the waiting work).
    const stalledBoard: Board = {
      prds: [
        {
          id: "auth",
          title: "AuthPRD",
          lane: "in-progress",
          stalled: true,
          issues: [{ id: "010-login", title: "Login", lane: "ready", readyFor: "agent" }],
        },
      ],
    };

    const off = stripAnsi(
      render(<App board={stalledBoard} autoRun={spyAutoRun(false)} />).lastFrame() ?? "",
    );
    expect(off).toContain("◌ stalled");

    const on = stripAnsi(
      render(<App board={stalledBoard} autoRun={spyAutoRun(true)} />).lastFrame() ?? "",
    );
    expect(on).not.toContain("stalled");
  });

  it("ignores `a` while a modal is open", async () => {
    // A dispatcher whose read returns a frontier, so `d` opens a modal.
    const dispatcher = {
      // A spawn candidate makes the selected PRD dispatchable, so `d` is eligible
      // and opens the preview — the modal these tests then prove swallows the next key.
      readFrontier: vi.fn(
        () =>
          [{ issue: { id: "001.md" } as DispatchIssue, classification: "spawn" }] as readonly FrontierEntry[],
      ),
      hasDispatchable: vi.fn(() => true),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => DispatchResult>(() => ({
        launched: 1,
        skipped: 0,
      })),
    };
    const autoRun = spyAutoRun();
    const { stdin } = render(
      <App board={board} dispatcher={dispatcher} autoRun={autoRun} />,
    );

    stdin.write("d"); // open the dispatch preview
    await tick();
    stdin.write("a"); // swallowed by the modal
    await tick();

    expect(autoRun.toggle).not.toHaveBeenCalled();
  });
});

describe("App reactor activity", () => {
  /** An auto-run seam whose toggle is a spy, defaulting to enabled. */
  function spyAutoRun(enabled = true) {
    return { enabled, toggle: vi.fn<() => void>() };
  }

  it("shows the working indicator when the Reactor is actively spawning", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(true)} activity="working" />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("working");
  });

  it("shows the idle indicator when auto-run is on but nothing is eligible", () => {
    // The signal an idle on-Reactor needs: a still board that is on, not braked.
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(true)} activity="idle" />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("idle");
  });

  it("shows the at-rest indicator when auto-run is off", () => {
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(false)} activity="at-rest" />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("at-rest");
  });

  it("renders the activity signal alongside the auto-run indicator, not replacing it", () => {
    // The two are distinct status-line elements (the Issue's acceptance criterion):
    // auto-run on/off is the brake, activity is whether it's moving. Both show.
    const { lastFrame } = render(
      <App board={board} autoRun={spyAutoRun(true)} activity="idle" />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("auto-run on");
    expect(frame).toContain("idle");
    expect(frame).toContain("? Show this help");
  });

  it("shows no activity indicator when none is wired (board-only tests)", () => {
    // Like the auto-run seam, the activity signal is absent in board-only renders;
    // its half of the status line is simply empty, never a phantom default.
    const { lastFrame } = render(<App board={board} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("working");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("at-rest");
  });
});

describe("App detail modal", () => {
  /** A detail reader resolving a fixed body for any card; spies record the call. */
  function spyDetailReader(detail?: CardDetail) {
    return {
      readDetail: vi.fn<(prdId: string, issueId?: string) => CardDetail | undefined>(
        () => detail,
      ),
    };
  }

  it("opens the modal on v at the board level showing the PRD's body", async () => {
    const detailReader = spyDetailReader({
      title: "AuthPRD",
      body: "## Problem\n\nThe board never shows the body.",
    });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v");
    await tick();

    // The board reader is asked for the selected PRD with no issue id (board level);
    // the single readDetail call passes `undefined` for the issue id off the board.
    expect(detailReader.readDetail).toHaveBeenCalledWith("auth", undefined);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("Problem");
    expect(frame).toContain("The board never shows the body.");
  });

  it("opens the modal on v when zoomed showing the selected Issue's body", async () => {
    const detailReader = spyDetailReader({
      title: "Login",
      body: "## What to build\n\nA login form.",
    });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues (selects 010-login)
    await tick();
    stdin.write("v");
    await tick();

    // Zoomed: the reader is asked for the selected PRD *and* Issue id.
    expect(detailReader.readDetail).toHaveBeenCalledWith("auth", "010-login");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("What to build");
    expect(frame).toContain("A login form.");
  });

  it("renders the human-review reason+note header above the body when zoomed", async () => {
    // The header is sourced from the parsed model fields on the selected Issue,
    // not the file; `readDetail` still supplies the frontmatter-stripped body.
    const reviewBoard: Board = {
      prds: [
        {
          id: "auth",
          title: "AuthPRD",
          lane: "in-progress",
          issues: [
            {
              id: "010-login",
              title: "Login",
              lane: "human-review",
              humanReviewReason: "non-convergence",
              humanReviewNote: "The auth test stays flaky after 3 passes.",
            },
          ],
        },
      ],
    };
    const detailReader = spyDetailReader({
      title: "Login",
      body: "## What to build\n\nA login form.",
    });
    const { stdin, lastFrame } = render(
      <App board={reviewBoard} detailReader={detailReader} />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues (selects the human-review Issue)
    await tick();
    stdin.write("v");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("non-convergence"); // reason heading, matching the card marker
    expect(frame).toContain("The auth test stays flaky after 3 passes."); // the note
    expect(frame).toContain("A login form."); // the body still renders beneath
  });

  it("renders no header on a non-human-review Issue — body only, unchanged", async () => {
    // The shared `board`'s 010-login is a plain backlog Issue (no reason/note), so
    // zooming + v shows the body alone with no escalation words leaking in.
    const detailReader = spyDetailReader({
      title: "Login",
      body: "## What to build\n\nA login form.",
    });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues (selects 010-login, backlog)
    await tick();
    stdin.write("v");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("A login form.");
    expect(frame).not.toMatch(/deviation|conflict|non-convergence/);
  });

  it("is a no-op on v when the file vanished (readDetail → undefined)", async () => {
    const detailReader = spyDetailReader(undefined); // file gone since the last scan
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v");
    await tick();

    expect(detailReader.readDetail).toHaveBeenCalledTimes(1);
    // No modal opened, no error: still on the board.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("BillPRD");
    expect(frame).not.toContain("close"); // the modal's dismiss hint is absent
  });

  it("shows the empty-body placeholder rather than a blank modal", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("(no body)");
  });

  it("does nothing on v when no detail reader is wired", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("v");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD"); // still the board
    expect(frame).not.toContain("close");
  });

  it("closes the modal on v (toggle) and restores the board", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "x" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v"); // open
    await tick();
    stdin.write("v"); // close
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("close");
    expect(frame).toContain("BillPRD"); // back on the board
  });

  it("closes the modal on Esc, restoring the zoom the user was in", async () => {
    const detailReader = spyDetailReader({ title: "Login", body: "x" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write("v"); // open the detail modal
    await tick();
    stdin.write(ESC); // close it
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("close"); // modal gone
    // Esc returned us exactly where we were — still zoomed into the Issues.
    expect(frame).toContain("Login");
    expect(frame).not.toContain("BillPRD"); // not backed out to the board
  });

  it("quits on q from the modal", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "x" });
    const { stdin, frames } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v"); // open the modal
    await tick();
    stdin.write("q"); // q quits everywhere, including the modal
    await tick();
    const framesAfterQuit = frames.length;

    // The app unmounted: further input produces no new frame.
    stdin.write(ARROW_DOWN);
    await tick();
    expect(frames.length).toBe(framesAfterQuit);
  });

  it("swallows other keys while the modal is open (no leak to the board)", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "x" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("v"); // open the modal on AuthPRD (first card)
    await tick();
    stdin.write(ARROW_DOWN); // would move selection if it leaked through
    await tick();
    stdin.write(ENTER); // would zoom if it leaked through
    await tick();
    stdin.write("v"); // close the modal
    await tick();

    // Selection never moved and we never zoomed: still board level, first card.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("AuthPRD");
    expect(frame).toContain("BillPRD");
    expect(frame).not.toContain("Login"); // never zoomed into Issues
  });

  it("ignores v while a dispatch preview is open (at most one modal)", async () => {
    const dispatcher = {
      // A spawn candidate makes the selected PRD dispatchable, so `d` is eligible
      // and opens the preview — the modal these tests then prove swallows the next key.
      readFrontier: vi.fn(
        () =>
          [{ issue: { id: "001.md" } as DispatchIssue, classification: "spawn" }] as readonly FrontierEntry[],
      ),
      hasDispatchable: vi.fn(() => true),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => DispatchResult>(() => ({
        launched: 1,
        skipped: 0,
      })),
    };
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "x" });
    const { stdin, lastFrame } = render(
      <App board={board} dispatcher={dispatcher} detailReader={detailReader} />,
    );

    stdin.write("d"); // open the dispatch preview
    await tick();
    stdin.write("v"); // swallowed by the preview — must not open the detail modal
    await tick();

    expect(detailReader.readDetail).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Dispatch");
  });

  it("ignores v while the help modal is open (at most one modal)", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "x" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
    );

    stdin.write("?"); // open help
    await tick();
    stdin.write("v"); // swallowed by help — must not open the detail modal
    await tick();

    expect(detailReader.readDetail).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Keybindings");
  });

  // A body taller than a short terminal: each marker is its own paragraph so it
  // renders to a distinct terminal line we can assert window membership on.
  const TALL = Array.from({ length: 20 }, (_, i) => `LINE${i}`).join("\n\n");
  // A terminal short enough that 20+ body lines overflow the modal viewport.
  const SHORT_ROWS = 12;

  // Two *long* paragraphs: only three logical lines (para, blank, para), but each
  // paragraph is far wider than the modal, so the terminal wraps each to many rows.
  // The unwrapped line count (3) fits the body region, so without wrapping the
  // rendered lines to the body width the scroll offset would clamp to 0 and the keys
  // go inert — issue #71. `ALPHA`/`OMEGA` mark the first/second paragraph so we can
  // assert the window actually moves from one to the other.
  const WIDE = [`ALPHA ${"lorem ".repeat(40)}`, `${"ipsum ".repeat(40)} OMEGA`].join(
    "\n\n",
  );

  it("scrolls the body down with j and up with k", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: TALL });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v"); // open — windowed at the top
    await tick();
    const top = stripAnsi(lastFrame() ?? "");
    expect(top).toContain("LINE0");
    expect(top).not.toContain("LINE19"); // the end is clipped below

    // Scroll down several lines — later content comes into view.
    for (let i = 0; i < 8; i++) {
      stdin.write("j");
      await tick();
    }
    const scrolled = stripAnsi(lastFrame() ?? "");
    expect(scrolled).not.toContain("LINE0"); // the top is now clipped above

    // Scroll back up — the top returns.
    for (let i = 0; i < 8; i++) {
      stdin.write("k");
      await tick();
    }
    expect(stripAnsi(lastFrame() ?? "")).toContain("LINE0");
  });

  it("scrolls a body of long wrapped paragraphs (issue #71)", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: WIDE });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      40, // narrow enough that each long paragraph wraps to many rows
      SHORT_ROWS,
    );

    stdin.write("v"); // open — windowed at the top
    await tick();
    const top = stripAnsi(lastFrame() ?? "");
    expect(top).toContain("ALPHA");
    expect(top).not.toContain("OMEGA"); // the second paragraph is below the fold
    expect(top).toMatch(/more below/); // and the affordance says there is more

    // Scroll well past the first paragraph — the second comes into view, the first
    // clips above. Before the wrap fix `maxOffset` was 0 here and `j` did nothing.
    for (let i = 0; i < 30; i++) {
      stdin.write("j");
      await tick();
    }
    const bottom = stripAnsi(lastFrame() ?? "");
    expect(bottom).toContain("OMEGA");
    expect(bottom).not.toContain("ALPHA");
  });

  it("scrolls with the down and up arrows too", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: TALL });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v");
    await tick();
    for (let i = 0; i < 8; i++) {
      stdin.write(ARROW_DOWN);
      await tick();
    }
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("LINE0");
    for (let i = 0; i < 8; i++) {
      stdin.write(ARROW_UP);
      await tick();
    }
    expect(stripAnsi(lastFrame() ?? "")).toContain("LINE0");
  });

  it("cannot scroll up past the start of the body", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: TALL });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v");
    await tick();
    for (let i = 0; i < 5; i++) {
      stdin.write("k"); // already at the top — no movement
      await tick();
    }
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE0"); // still at the top
    expect(frame).not.toMatch(/more above/); // no above-affordance at the start
  });

  it("cannot scroll down past the end of the body", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: TALL });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v");
    await tick();
    for (let i = 0; i < 50; i++) {
      stdin.write("j"); // far past the end — clamps at the last full window
      await tick();
    }
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE19"); // the end is shown
    expect(frame).not.toMatch(/more below/); // nothing left below
  });

  it("shows no scroll affordance and ignores scroll keys for a body that fits", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: "short body" });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).not.toMatch(/more below|more above/);

    stdin.write("j"); // ignored — nothing to scroll
    await tick();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("short body");
    expect(frame).not.toMatch(/more above/);
  });

  it("resets the scroll position when the modal is reopened", async () => {
    const detailReader = spyDetailReader({ title: "AuthPRD", body: TALL });
    const { stdin, lastFrame } = render(
      <App board={board} detailReader={detailReader} />,
      240,
      SHORT_ROWS,
    );

    stdin.write("v");
    await tick();
    for (let i = 0; i < 8; i++) {
      stdin.write("j");
      await tick();
    }
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("LINE0");

    stdin.write("v"); // close
    await tick();
    stdin.write("v"); // reopen — back at the top
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("LINE0");
  });
});

describe("App review-pass marker", () => {
  // A PRD whose Issues exercise the three review-pass cases: a live in-review card
  // (carries the count), an orphaned in-review card (Orphan marker wins, no count),
  // and a done card (off the lane, no count). The scanner sets `reviewPass` only on
  // the live in-review Issue, exactly as it would on a real board.
  const reviewBoard: Board = {
    prds: [
      {
        id: "auth",
        title: "AuthPRD",
        lane: "in-progress",
        issues: [
          {
            id: "010-live",
            title: "Reviewing",
            lane: "in-review",
            liveness: "live",
            reviewPass: 2,
          },
          {
            id: "020-orphan",
            title: "Stuck",
            lane: "in-review",
            liveness: "orphaned",
          },
          { id: "030-done", title: "Shipped", lane: "done" },
        ],
      },
    ],
  };

  /** Zoom into AuthPRD's Issue board so every Issue card renders. */
  async function zoomIn(): Promise<ReturnType<typeof render>> {
    const handles = render(<App board={reviewBoard} reviewCap={3} />);
    handles.stdin.write(ENTER);
    await tick();
    return handles;
  }

  it("shows the N/cap marker on a live in-review card, cap sourced from config", async () => {
    const { lastFrame } = await zoomIn();
    const frame = stripAnsi(lastFrame() ?? "");

    expect(frame).toContain("2/3");
    expect(frame).toContain("Reviewing");
  });

  it("shows no count on an orphaned in-review card — the Orphan marker wins", async () => {
    const { lastFrame } = await zoomIn();
    const frame = stripAnsi(lastFrame() ?? "");

    // The orphan carries its loud liveness marker and no count line. The only
    // `N/3` anywhere is the live card's own 2/3 — no second count crept in for the
    // orphan, so its card is countless.
    expect(frame).toContain("⚠ orphaned");
    expect(frame.match(/\d+\/3/g)).toEqual(["2/3"]);
  });

  it("shows no count once an Issue has left the in-review lane (done)", async () => {
    // The done card carries no reviewPass (the scanner gates it off the lane), so
    // only the live in-review card's 2/3 appears anywhere on the board.
    const { lastFrame } = await zoomIn();
    const frame = stripAnsi(lastFrame() ?? "");

    expect(frame).toContain("Shipped");
    expect(frame.match(/\d+\/3/g)).toEqual(["2/3"]);
  });
});

describe("dispatchOutcomeNotice", () => {
  it("reports a fully successful wave with the launched count", () => {
    expect(dispatchOutcomeNotice({ launched: 3, skipped: 0 })).toBe(
      "Dispatched 3 agents in the background.",
    );
    // Singular when exactly one launched.
    expect(dispatchOutcomeNotice({ launched: 1, skipped: 0 })).toBe(
      "Dispatched 1 agent in the background.",
    );
  });

  it("reports a failure (no agents) pointing at the log when every candidate skipped", () => {
    const notice = dispatchOutcomeNotice({ launched: 0, skipped: 2 });
    expect(notice).toContain("Dispatched no agents");
    expect(notice).toContain("2 candidates failed to start");
    expect(notice).toContain("dispatch log");
  });

  it("reports both counts for a partial wave", () => {
    const notice = dispatchOutcomeNotice({ launched: 2, skipped: 1 });
    expect(notice).toContain("Dispatched 2 agents");
    expect(notice).toContain("1 failed to start");
  });

  it("reports nothing-to-dispatch when neither launched nor skipped", () => {
    expect(dispatchOutcomeNotice({ launched: 0, skipped: 0 })).toBe(
      "Nothing to dispatch.",
    );
  });
});
