import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { Card } from "./Card.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const frameOf = (el: React.ReactElement): string =>
  stripAnsi(render(el).lastFrame() ?? "");

/** The raw, ANSI-bearing frame — for asserting colour (e.g. the cyan border). */
const rawFrameOf = (el: React.ReactElement): string =>
  render(el).lastFrame() ?? "";

// The SGR code Ink emits for a cyan foreground (the selected card's border).
const CYAN = ESC + "[36m";

describe("Card selection treatment", () => {
  it("indicates a selected card with its cyan border alone", () => {
    // The border flips to cyan on select; that is the sole selection cue. An
    // unselected card carries no cyan.
    const selected = rawFrameOf(<Card title="Focused" selected />);
    const unselected = rawFrameOf(<Card title="Focused" />);

    expect(selected).toContain(CYAN);
    expect(unselected).not.toContain(CYAN);
  });

  it("does not prepend the ▶ arrow to a selected card's title", () => {
    // The arrow used to cost the title two columns — the focused card truncated
    // earlier than its neighbours. Selection no longer taxes the title line.
    const frame = frameOf(<Card title="Focused" selected />);

    expect(frame).not.toContain("▶");
  });

  it("does not truncate a selected card's title earlier than an unselected one", () => {
    // No two-character arrow tax: the same title shows identically whether or not
    // the card is selected — the selected card is never the narrower of the two.
    const title = "Share one failed-set across all spawn edges";
    const selected = frameOf(<Card title={title} selected />);
    const unselected = frameOf(<Card title={title} />);

    expect(selected).toContain(title);
    expect(selected).toEqual(unselected);
  });

  it("leaves a coloured marker line legible on a selected card", () => {
    // No `inverse` muddying: the live marker renders the same on a selected card
    // as on an unselected one, so selection and status never fight visually.
    const selected = frameOf(<Card title="Working" selected liveness="live" />);

    expect(selected).toContain("● live");
    expect(selected).toContain("Working");
  });

  it("keeps the rounded border on every card, selected or not", () => {
    // The cyan-border cue needs every card to carry a border so the selected
    // one's cyan reads against neutral neighbours. The rounded glyphs stay.
    const selected = frameOf(<Card title="A" selected />);
    const unselected = frameOf(<Card title="B" />);

    for (const corner of ["╭", "╮", "╰", "╯"]) {
      expect(selected).toContain(corner);
      expect(unselected).toContain(corner);
    }
  });
});

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

describe("Card malformed-status marker", () => {
  it("flags a malformed-status card with a warning marker reading 'bad status'", () => {
    const frame = frameOf(<Card title="Mystery" malformedStatus />);

    expect(frame).toContain("⚠ bad status");
    expect(frame).toContain("Mystery");
  });

  it("shows no malformed-status marker on a card with a recognised status", () => {
    const frame = frameOf(<Card title="Healthy" />);

    expect(frame).not.toContain("bad status");
    expect(frame).toContain("Healthy");
  });

  it("renders a malformed backlog card distinct from a plain backlog card", () => {
    // A folded malformed-status Issue and an ordinary backlog Issue both sit in
    // the backlog column; the marker is the only thing that tells them apart, so a
    // data error stays loud and triageable rather than silently parked.
    const malformed = frameOf(<Card title="Mystery" malformedStatus />);
    const plain = frameOf(<Card title="Real backlog" />);

    expect(malformed).toContain("⚠ bad status");
    expect(plain).not.toContain("bad status");
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

  it("never renders a human-review marker alongside the suppressed marker", () => {
    // The same last-line-of-defence guard covers the human-review marker, not just
    // liveness: disjoint lanes mean the scanner never co-sets them, but even handed
    // both, suppressed wins and the yellow reason line never leaks through.
    const both = frameOf(
      <Card title="Parked" suppressed humanReviewReason="conflict" />,
    );

    expect(both).toContain("⊘ suppressed");
    expect(both).not.toMatch(/⚠ deviation|↻ non-convergence|✗ conflict/);
  });
});

describe("Card linked-PR marker", () => {
  it("marks a done PRD with an open PR with a 'PR open' marker", () => {
    const frame = frameOf(
      <Card title="Shipped" linkedPr={{ state: "open", url: "https://gh/1" }} />,
    );

    expect(frame).toContain("PR open");
    expect(frame).toContain("Shipped");
  });

  it("marks a done PRD with a merged PR with a 'PR merged' marker — the end-of-lifecycle signal", () => {
    const frame = frameOf(
      <Card title="Landed" linkedPr={{ state: "merged", url: "https://gh/2" }} />,
    );

    expect(frame).toContain("PR merged");
    expect(frame).toContain("Landed");
  });

  it("renders the open and merged markers distinctly (the three-state distinction)", () => {
    // The two PR states must read apart — *merged* is the real end-of-lifecycle
    // signal, distinct from a still-open PR awaiting merge — so each carries its
    // own glyph + word and neither can be mistaken for the other.
    const open = frameOf(
      <Card title="A" linkedPr={{ state: "open", url: "https://gh/1" }} />,
    );
    const merged = frameOf(
      <Card title="B" linkedPr={{ state: "merged", url: "https://gh/2" }} />,
    );

    expect(open).toContain("PR open");
    expect(open).not.toContain("PR merged");
    expect(merged).toContain("PR merged");
    expect(merged).not.toContain("PR open");
  });

  it("shows no PR marker on a card with no linked PR (the third, no-PR state)", () => {
    // *No PR* is the marker's absence — a finished PRD still needing one looks
    // distinct from one that has it precisely because it carries no PR line.
    const frame = frameOf(<Card title="Unopened" />);

    expect(frame).not.toMatch(/PR open|PR merged/);
    expect(frame).toContain("Unopened");
  });
});
