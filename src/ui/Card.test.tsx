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

// The SGR codes Ink emits for the selection cues: a magenta foreground (the
// selected card's border) and the inverse attribute (its title bar).
const MAGENTA = ESC + "[35m";
const INVERSE = ESC + "[7m";

describe("Card selection treatment", () => {
  it("indicates a selected card with a magenta border and an inverse title bar", () => {
    // Two cues on select (issue #75): the border flips to magenta — not cyan,
    // which marks an open Linked PR — and the title renders as an inverse bar so
    // it pops on a busy board. An unselected card carries neither.
    const selected = rawFrameOf(<Card title="Focused" selected />);
    const unselected = rawFrameOf(<Card title="Focused" />);

    expect(selected).toContain(MAGENTA);
    expect(selected).toContain(INVERSE);
    expect(unselected).not.toContain(MAGENTA);
    expect(unselected).not.toContain(INVERSE);
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
    // The inverse bar is scoped to the title alone: the live marker renders the
    // same on a selected card as on an unselected one, so selection and status
    // never fight visually.
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

describe("Card task-number id line", () => {
  it("shows the Issue's NNN task number under the title", () => {
    const frame = frameOf(
      <Card id="007-session-tokens.md" title="Session tokens" />,
    );

    expect(frame).toContain("#007");
    expect(frame).toContain("Session tokens");
  });

  it("preserves the leading-zero padding of the task number", () => {
    // The id reads exactly as Overseer refers to it in conversation and in
    // blocked_by references — `001`, not `1`.
    const frame = frameOf(<Card id="001-password-hashing.md" title="Hashing" />);

    expect(frame).toContain("#001");
  });

  it("shows no id line for a PRD whose id is a directory name", () => {
    // A PRD carries a directory-name id with no numeric prefix, so it surfaces no
    // task number and renders no id line.
    const frame = frameOf(<Card id="auth-system" title="Auth system" />);

    expect(frame).not.toContain("#");
    expect(frame).toContain("Auth system");
  });

  it("shows no id line on a card handed no id", () => {
    const frame = frameOf(<Card title="Plain" />);

    expect(frame).not.toContain("#");
    expect(frame).toContain("Plain");
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
    // An in-review card carrying a resolve-edge suppression (ADR 0019) can also
    // carry a liveness verdict — its reviewer is dead — so the scanner DOES set both
    // here (no longer disjoint lanes). The Card resolves the overlap by precedence:
    // suppressed wins and the liveness marker never leaks through.
    const both = frameOf(<Card title="Parked" suppressed liveness="orphaned" />);

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

  it("outranks the neutral N/cap review marker — a held merge is never masked by the count", () => {
    // An in-review card carrying a resolve-edge suppression can also have a recorded
    // review pass (ADR 0019). The suppressed marker outranks the neutral `N/cap`
    // count on the card, mirroring how the Orphan marker outranks it: a held merge
    // stays visible rather than hidden behind the healthy in-progress signal.
    const both = frameOf(
      <Card title="Held" suppressed reviewPass={2} reviewCap={3} />,
    );

    expect(both).toContain("⊘ suppressed");
    expect(both).not.toMatch(/\d+\/\d+/);
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

  it("renders an N/M merged signal for a stacked PRD instead of the three-state marker", () => {
    // A stack has no single PR — the card shows the aggregate `N/M merged` count
    // (ADR 0025), not the plain `PR open`/`PR merged` marker.
    const frame = frameOf(
      <Card
        title="Stacked"
        linkedPr={{ state: "open", url: "https://gh/1", stack: { merged: 2, total: 3 } }}
      />,
    );

    expect(frame).toContain("2/3 merged");
    expect(frame).not.toContain("PR open");
    expect(frame).toContain("Stacked");
  });

  it("reads a fully-landed stack (N = M) as its complete N/M merged count", () => {
    const frame = frameOf(
      <Card
        title="Landed"
        linkedPr={{ state: "merged", url: "https://gh/1", stack: { merged: 3, total: 3 } }}
      />,
    );

    expect(frame).toContain("3/3 merged");
    expect(frame).toContain("Landed");
  });
});

describe("Card review-pass marker", () => {
  it("shows an N/cap marker on a card with a review pass and cap", () => {
    const frame = frameOf(<Card title="Reviewing" reviewPass={1} reviewCap={3} />);

    expect(frame).toContain("1/3");
    expect(frame).toContain("Reviewing");
  });

  it("advances the numerator with the recorded pass", () => {
    const frame = frameOf(<Card title="Reviewing" reviewPass={2} reviewCap={3} />);

    expect(frame).toContain("2/3");
  });

  it("reflects a tuned cap in the denominator", () => {
    // The denominator is the configured cap, not a literal 3 — a board that tuned
    // the cap down reads honestly.
    const frame = frameOf(<Card title="Reviewing" reviewPass={1} reviewCap={5} />);

    expect(frame).toContain("1/5");
  });

  it("shows no count on a card with no review pass", () => {
    // Absent pass ⇒ no marker, never a false 0/cap from a default.
    const frame = frameOf(<Card title="Plain" reviewCap={3} />);

    expect(frame).not.toMatch(/\d+\/\d+/);
    expect(frame).toContain("Plain");
  });

  it("renders the review-pass marker outside the yellow and red marker families", () => {
    // The neutral in-progress path: its glyph must read apart from the yellow
    // warning family (orphaned, the human-review reasons, bad status) and the red
    // `⊘ suppressed` nothing-ran family. The renderer strips ANSI, so the glyph is
    // the observable distinction.
    const frame = frameOf(<Card title="Reviewing" reviewPass={1} reviewCap={3} />);

    expect(frame).toContain("1/3");
    expect(frame).not.toMatch(/⚠|↻|✗|⊘/);
  });
});

describe("Card needs-review marker", () => {
  it("marks a PRD whose Issues need review with a 'needs review' marker", () => {
    const frame = frameOf(<Card title="Blocked" needsReview />);

    expect(frame).toContain("⚠ needs review");
    expect(frame).toContain("Blocked");
  });

  it("shows no needs-review marker on a PRD that does not need review", () => {
    const frame = frameOf(<Card title="Humming" />);

    expect(frame).not.toContain("needs review");
    expect(frame).toContain("Humming");
  });

  it("never co-renders the needs-review marker with the Linked PR marker", () => {
    // The two PRD-level markers live in disjoint columns — Linked PR is `done`-only,
    // needs-review implies not-done — so a real card never carries both. Even if a
    // card is handed both, the two must not collide: the needs-review marker shows
    // and the Linked PR marker does not leak through.
    const both = frameOf(
      <Card title="Conflict" needsReview linkedPr={{ state: "merged", url: "https://gh/3" }} />,
    );

    expect(both).toContain("⚠ needs review");
    expect(both).not.toMatch(/PR open|PR merged/);
  });
});

describe("Card stalled marker", () => {
  it("marks a stalled PRD when auto-run is off", () => {
    const frame = frameOf(<Card title="Waiting" stalled autoRunOff />);

    expect(frame).toContain("◌ stalled");
    expect(frame).toContain("Waiting");
  });

  it("shows no stalled marker when auto-run is on (the Reactor is coming)", () => {
    const frame = frameOf(<Card title="Humming" stalled />);

    expect(frame).not.toContain("stalled");
    expect(frame).toContain("Humming");
  });

  it("shows no stalled marker on a PRD that is not stalled", () => {
    const frame = frameOf(<Card title="Idle" autoRunOff />);

    expect(frame).not.toContain("stalled");
  });
});
