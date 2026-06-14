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

describe("Card liveness marker", () => {
  it("marks a card whose agent is live with a live marker", () => {
    const frame = frameOf(<Card title="Payments" liveness="live" />);

    expect(frame).toContain("live");
    expect(frame).toContain("Payments");
  });

  it("marks a card whose agent is unobserved with an unknown marker", () => {
    const frame = frameOf(<Card title="Tokens" liveness="unknown" />);

    expect(frame).toContain("unknown");
    expect(frame).toContain("Tokens");
  });

  it("marks an orphaned card with an orphaned marker", () => {
    const frame = frameOf(<Card title="Stuck" liveness="orphaned" />);

    expect(frame).toContain("orphaned");
    expect(frame).toContain("Stuck");
  });

  it("renders the orphaned marker distinct from the unknown dimming", () => {
    // The orphan is an attention signal (stuck, recoverable with `R`), not the
    // quiet "this session can't see it" of unknown — so it must read differently
    // on the card. Each carries its own glyph + word, so neither's marker can be
    // mistaken for the other's (ADR 0009). (Colour also differs — yellow warning
    // vs gray dim — but the test renderer strips ANSI, so the glyph is the
    // observable distinction here.)
    const orphaned = frameOf(<Card title="Stuck" liveness="orphaned" />);
    const unknown = frameOf(<Card title="Quiet" liveness="unknown" />);

    expect(orphaned).toContain("⚠ orphaned");
    expect(orphaned).not.toContain("○ unknown");
    expect(unknown).toContain("○ unknown");
    expect(unknown).not.toContain("⚠ orphaned");
  });

  it("shows no liveness marker on a card without a verdict", () => {
    const frame = frameOf(<Card title="Plain" />);

    expect(frame).not.toMatch(/live|unknown|orphaned/);
    expect(frame).toContain("Plain");
  });
});
