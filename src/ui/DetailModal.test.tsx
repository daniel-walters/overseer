import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DetailModal } from "./DetailModal.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

describe("DetailModal", () => {
  it("renders the card title as the modal heading", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "Detail modal", body: "# Body\n\nsome text" }} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("Detail modal");
  });

  it("renders the markdown body's prose content (not the raw source)", () => {
    // The contract is "the body shows, rendered" — we assert the prose lands in the
    // frame. ink-markdown / marked-terminal own the markdown→ANSI transform itself
    // (its heading styling, list bullets), so we don't re-test that here; we only
    // prove our modal hands the body through the renderer and shows the result.
    const { lastFrame } = render(
      <DetailModal
        detail={{ title: "T", body: "## What to build\n\nThe end-to-end body view." }}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("What to build");
    expect(frame).toContain("The end-to-end body view.");
  });

  it("shows a quiet placeholder for an empty body rather than a blank modal", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "Empty", body: "" }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Empty"); // the title still renders
    expect(frame).toContain("(no body)"); // the placeholder, not a blank pane
  });

  it("treats a whitespace-only body as empty (still the placeholder)", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "Blank", body: "   \n\n  " }} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("(no body)");
  });

  it("renders a dismiss hint so the viewer knows how to close", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "T", body: "x" }} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Esc");
  });

  // A body of eight one-line paragraphs renders to ~15 terminal lines (each
  // paragraph plus a blank separator); a small `viewportRows` forces a window.
  const tallBody = Array.from({ length: 8 }, (_, i) => `LINE${i}`).join("\n\n");

  it("renders only the window of lines that fits the viewport, not the whole body", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "T", body: tallBody }} scrollOffset={0} viewportRows={3} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE0");
    expect(frame).not.toContain("LINE7"); // clipped below the window
  });

  it("reflects the scroll offset — a later window shows later lines", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "T", body: tallBody }} scrollOffset={99} viewportRows={3} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("LINE7"); // scrolled (and clamped) to the end
    expect(frame).not.toContain("LINE0"); // first line now clipped above
  });

  it("shows an overflow affordance when there is more body below", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "T", body: tallBody }} scrollOffset={0} viewportRows={3} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toMatch(/more below|▾|↓/);
  });

  it("shows no overflow affordance when the whole body fits", () => {
    const { lastFrame } = render(
      <DetailModal detail={{ title: "T", body: "just one line" }} scrollOffset={0} viewportRows={20} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toMatch(/more below|more above/);
  });
});
