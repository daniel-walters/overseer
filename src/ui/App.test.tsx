import { describe, it, expect, vi } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { App } from "./App.js";
import { KEYBINDS } from "./keybinds.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue } from "../dispatch/reader.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";
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

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const ARROW_DOWN = ESC + "[B";

const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Let Ink flush input and re-render. */
const tick = () => new Promise((r) => setTimeout(r, 20));

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
    return { id, title: id, path: `/root/auth/${id}`, status: "ready-for-agent", blockedBy: [], repo: "/r", worktree: undefined, branch: undefined, deviation: undefined, body: "" };
  }

  /** A frontier with one spawn candidate and one skipped Issue. */
  function fakeFrontier(prdId: string): readonly FrontierEntry[] {
    return [
      { issue: di("010-spawn.md"), classification: "spawn" },
      { issue: di("020-skip.md"), classification: "skipped", reason: `(${prdId}) not ready` },
    ];
  }

  /** A dispatcher whose two seams are spies, with a sensible default frontier. */
  function spyDispatcher(
    overrides: Partial<{ readFrontier: (id: string) => readonly FrontierEntry[] }> = {},
  ) {
    return {
      readFrontier: vi.fn(overrides.readFrontier ?? fakeFrontier),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => void>(),
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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch ");
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
    expect(frame).not.toContain("Dispatch ");
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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch ");
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
    expect(frame).not.toContain("Dispatch ");
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

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Dispatch ");
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
      body: "",
      ...overrides,
    };
  }

  const prdContext = { prdTitle: "AuthPRD", prdBody: "auth", featureBranch: "auth" };

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
    const { stdin, lastFrame } = render(<App board={board} reviewer={reviewer} />);

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
    const { stdin, lastFrame } = render(<App board={board} reviewer={reviewer} />);

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
    const { stdin, lastFrame } = render(<App board={board} reviewer={reviewer} />);

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
    const { stdin, lastFrame } = render(<App board={board} reviewer={reviewer} />);

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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch ");
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
    expect(frame).not.toContain("Re-dispatch"); // modal closed
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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch");
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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch");
  });

  it("does nothing on R at the board level (recovery is Issue-level only)", async () => {
    const rollback = spyRollback();
    const { stdin, lastFrame } = render(
      <App board={orphanBoard} rollback={rollback} />,
    );

    stdin.write("R"); // at board level, no zoom
    await tick();

    expect(rollback.readRollback).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch");
  });

  it("does nothing on R when no rollback seam is wired", async () => {
    const { stdin, lastFrame } = render(<App board={orphanBoard} />);

    stdin.write(ENTER);
    await tick();
    stdin.write("R");
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Re-dispatch");
  });
});

describe("App kill (K on a live card)", () => {
  // The same orphanBoard shape: first Issue is the orphan, second (020-oauth) is
  // the *live* card — the one a kill targets.
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

  /** Zoom in and move the cursor to the live second Issue (020-oauth). */
  async function selectLive(stdin: { write: (s: string) => void }) {
    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    stdin.write(ARROW_DOWN); // first Issue is the orphan; move to the live one
    await tick();
  }

  it("opens a kill preview on K for the selected live Issue", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLive(stdin);
    stdin.write("K");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Stop 020-oauth's agent");
    expect(killer.readKill).toHaveBeenCalledWith("auth", "020-oauth");
  });

  it("stops the agent on confirm, then closes the modal with a notice", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLive(stdin);
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

    await selectLive(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("no longer running");
  });

  it("surfaces an 'uncertain' notice when the stop could not be confirmed", async () => {
    const killer = spyKiller(() => "uncertain");
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLive(stdin);
    stdin.write("K");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(stripAnsi(lastFrame() ?? "")).toContain("Couldn't confirm");
  });

  it("surfaces an 'unavailable' notice when claude could not be launched", async () => {
    const killer = spyKiller(() => "unavailable");
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLive(stdin);
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

    await selectLive(stdin);
    stdin.write("K");
    await tick();

    expect(killer.kill).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop 020-oauth"); // no modal
    expect(stripAnsi(lastFrame() ?? "")).toContain("no recorded agent to stop");
  });

  it("clears the kill notice on the next keypress", async () => {
    const killer = spyKiller();
    const { stdin, lastFrame } = render(<App board={orphanBoard} killer={killer} />);

    await selectLive(stdin);
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

    await selectLive(stdin);
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
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop ");
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

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Stop ");
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

  it("surfaces a gh/git failure loudly in the status line, opening no PR notice", async () => {
    const opener = spyOpenPr(() => ({ ok: false, error: "gh: not authenticated" }));
    const { stdin, lastFrame } = render(<App board={doneBoard} openPr={opener} />);

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

    stdin.write("P"); // open the preview on AuthPRD (first, done)
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
    expect(frame).toContain("? help");
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
      readFrontier: vi.fn(() => [] as readonly FrontierEntry[]),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => void>(),
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
    expect(stripAnsi(lastFrame() ?? "")).toContain("? help");
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

describe("App bottom-row keybind hints", () => {
  it("surfaces the d dispatch keybind as a persistent bottom-row hint, without opening help", () => {
    // The primary ignition gesture must be discoverable on the board itself, not
    // only behind `?`. The hint shows whenever the board is up.
    const { lastFrame } = render(<App board={board} />);
    const frame = stripAnsi(lastFrame() ?? "");

    // The bottom row carries the dispatch binding and its siblings — visible
    // without ever opening the help modal.
    expect(frame).toContain("d dispatch");
    expect(frame).not.toContain("Keybindings"); // help is not open
  });

  it("includes the sibling review keybind in the bottom-row hint", () => {
    const { lastFrame } = render(<App board={board} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("r review");
  });

  it("keeps the bottom-row hints at the Issue level too", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("d dispatch");
  });

  it("separates the auto-run indicator from the keybind hints with spacing", () => {
    // The auto indicator and the `? help` hint used to render flush; they must
    // read as distinct elements. With both on the bottom bar there is visible
    // whitespace between the indicator text and the first hint.
    const { lastFrame } = render(
      <App board={board} autoRun={{ enabled: true, toggle: () => {} }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    const barLine = frame.split("\n").find((l) => l.includes("auto-run on"));
    expect(barLine).toBeDefined();
    // The indicator and the hints are not jammed together — there is whitespace
    // between the end of "auto-run on" and the start of the keybind hints.
    expect(barLine).toMatch(/auto-run on\s{2,}.*\? help/);
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
    expect(frame).toContain("? help");
  });

  it("ignores `a` while a modal is open", async () => {
    // A dispatcher whose read returns a frontier, so `d` opens a modal.
    const dispatcher = {
      readFrontier: vi.fn(() => [] as readonly FrontierEntry[]),
      dispatch: vi.fn<(f: readonly FrontierEntry[]) => void>(),
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
    expect(frame).toContain("? help");
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
