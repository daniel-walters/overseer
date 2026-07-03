import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { AgentOutputModal } from "./AgentOutputModal.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

describe("AgentOutputModal", () => {
  it("renders the Issue title as the modal heading", () => {
    const { lastFrame } = render(
      <AgentOutputModal output={{ title: "OAuth agent", output: "starting up\n" }} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("OAuth agent");
  });

  it("renders the raw output as-is (not run through the markdown renderer)", () => {
    // Agent output is raw terminal scrollback: a leading `#`, a bare `---`, and a
    // fence must read literally, never reinterpreted as a heading / hr / code block.
    const { lastFrame } = render(
      <AgentOutputModal
        output={{ title: "T", output: "# not a heading\n---\n```\nstack\n```" }}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("# not a heading"); // the literal hash survives
    expect(frame).toContain("```"); // the literal fence survives
  });

  it("shows a quiet placeholder for empty output rather than a blank modal", () => {
    // The agent spawned but has printed nothing yet — the modal opened, the agent is
    // simply quiet, so the user must be able to tell that apart from a blank pane.
    const { lastFrame } = render(
      <AgentOutputModal output={{ title: "Quiet", output: "" }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Quiet"); // the title still renders
    expect(frame).toContain("(no output yet)"); // the placeholder, not a blank pane
  });

  it("treats whitespace-only output as empty (still the placeholder)", () => {
    const { lastFrame } = render(
      <AgentOutputModal output={{ title: "Blank", output: "   \n\n  " }} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("(no output yet)");
  });

  // Eight output lines; a small `viewportRows` forces a window.
  const tallOutput = Array.from({ length: 8 }, (_, i) => `LINE${i}`).join("\n");

  it("renders only the window of lines that fits the viewport, not the whole output", () => {
    const { lastFrame } = render(
      <AgentOutputModal
        output={{ title: "T", output: tallOutput }}
        scrollOffset={0}
        viewportRows={3}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE0");
    expect(frame).not.toContain("LINE7"); // clipped below the window
  });

  it("reflects the scroll offset — a later window shows later lines", () => {
    const { lastFrame } = render(
      <AgentOutputModal
        output={{ title: "T", output: tallOutput }}
        scrollOffset={99}
        viewportRows={3}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE7"); // scrolled (and clamped) to the end
    expect(frame).not.toContain("LINE0"); // first line now clipped above
  });

  it("shows above/below affordances when there is more output to scroll to", () => {
    const top = render(
      <AgentOutputModal
        output={{ title: "T", output: tallOutput }}
        scrollOffset={0}
        viewportRows={3}
      />,
    );
    expect(stripAnsi(top.lastFrame() ?? "")).toMatch(/more below|▾|↓/);

    const mid = render(
      <AgentOutputModal
        output={{ title: "T", output: tallOutput }}
        scrollOffset={2}
        viewportRows={3}
      />,
    );
    expect(stripAnsi(mid.lastFrame() ?? "")).toMatch(/more above|▴|↑/);
  });

  it("shows no overflow affordance when the whole output fits", () => {
    const { lastFrame } = render(
      <AgentOutputModal
        output={{ title: "T", output: "just one line" }}
        scrollOffset={0}
        viewportRows={20}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toMatch(/more below|more above/);
  });

  it("renders a close/scroll hint, not one implying a live tail", () => {
    const { lastFrame } = render(
      <AgentOutputModal output={{ title: "T", output: "x" }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("o / Esc to close");
    expect(frame).toContain("q to quit");
    // It is a frozen snapshot, not a stream — the hint must not promise a tail.
    expect(frame).not.toMatch(/tail|follow|live/i);
  });

  it("renders an r-to-refresh hint alongside the scroll/close/quit hints", () => {
    // `r` refreshes the snapshot in place (ADR 0031); the hint makes the gesture
    // discoverable without reading docs, and — like the rest — must not imply a tail.
    const { lastFrame } = render(
      <AgentOutputModal output={{ title: "T", output: "x" }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("r to refresh");
    expect(frame).not.toMatch(/tail|follow|live/i);
  });
});
