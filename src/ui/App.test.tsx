import { describe, it, expect, vi } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { App } from "./App.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue } from "../dispatch/reader.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";

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

  it("lists every keybind the input handler implements", async () => {
    const { stdin, lastFrame } = render(<App board={board} />);

    stdin.write("?");
    await tick();

    const frame = stripAnsi(lastFrame() ?? "");
    // A drift guard: the help modal is a hand-maintained second copy of the
    // bindings App implements. Each binding's *action* phrase must appear, so
    // deleting a row trips the test — asserting bare keys like "d"/"q" would not,
    // since those letters appear elsewhere in the modal regardless of the rows.
    expect(frame).toContain("Move selection"); // h j k l / arrows
    expect(frame).toContain("Zoom into a PRD's Issues"); // Enter
    expect(frame).toContain("Back out to the board"); // Esc
    expect(frame).toContain("Dispatch a wave"); // d
    expect(frame).toContain("Review the selected Issue"); // r
    expect(frame).toContain("Toggle auto-run"); // a
    expect(frame).toContain("Show this help"); // ?
    expect(frame).toContain("Quit"); // q
    // The movement keys, and the context labels that tell you where each works.
    expect(frame).toContain("h j k l");
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
