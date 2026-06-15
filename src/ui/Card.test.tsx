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

describe("Card suppressed marker", () => {
  it("marks a suppressed card with the suppressed marker", () => {
    const frame = frameOf(<Card title="Queued" suppressed />);

    expect(frame).toContain("⊘ suppressed");
    expect(frame).toContain("Queued");
  });

  it("shows no suppressed marker on a card that is not suppressed", () => {
    const frame = frameOf(<Card title="Healthy" />);

    expect(frame).not.toContain("suppressed");
    expect(frame).toContain("Healthy");
  });

  it("renders the suppressed marker as distinct from the liveness family", () => {
    // The suppressed marker reads apart from the yellow liveness family by glyph:
    // `⊘` vs `●`/`○`/`⚠`.
    const suppressed = frameOf(<Card title="Parked" suppressed />);

    expect(suppressed).toContain("⊘ suppressed");
    expect(suppressed).not.toMatch(/● live|○ unknown|⚠ orphaned/);
  });

  it("never renders a liveness marker alongside the suppressed marker", () => {
    // Disjoint lanes mean the scanner never sets both fields (see the scanner's
    // disjointness test), but the Card is the last line of defence: even handed
    // both, it must read as one coherent state — suppressed wins, no liveness
    // marker leaks through.
    const both = frameOf(<Card title="Parked" suppressed liveness="live" />);

    expect(both).toContain("⊘ suppressed");
    expect(both).not.toMatch(/● live|○ unknown|⚠ orphaned/);
  });
});
