import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { Card } from "./Card.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const frameOf = (el: React.ReactElement): string =>
  stripAnsi(render(el).lastFrame() ?? "");

describe("Card human-review reason marker", () => {
  it("marks a card escalated for a deviation with a deviation marker", () => {
    const frame = frameOf(<Card title="Login" humanReviewReason="deviation" />);

    expect(frame).toContain("deviation");
    expect(frame).toContain("Login");
  });

  it("marks a card escalated for a merge conflict with a conflict marker", () => {
    const frame = frameOf(<Card title="OAuth" humanReviewReason="conflict" />);

    expect(frame).toContain("conflict");
  });

  it("marks a card escalated for non-convergence distinctly", () => {
    const frame = frameOf(
      <Card title="Tokens" humanReviewReason="non-convergence" />,
    );

    expect(frame).toContain("non-convergence");
  });

  it("shows no reason marker on a card without one", () => {
    const frame = frameOf(<Card title="Plain" />);

    expect(frame).not.toMatch(/deviation|conflict|non-convergence/);
    expect(frame).toContain("Plain");
  });
});
