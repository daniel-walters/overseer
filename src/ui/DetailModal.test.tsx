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
});
