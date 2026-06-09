import { describe, it, expect, vi } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { App } from "./App.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue } from "../dispatch/reader.js";

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
