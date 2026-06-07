import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import type { Board } from "../model.js";

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
