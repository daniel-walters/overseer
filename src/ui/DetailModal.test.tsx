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

  describe("human-review header", () => {
    it("renders the reason and note above the body for a human-review Issue carrying both", () => {
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "Stuck on auth",
            body: "The Issue body proper.",
            humanReviewReason: "non-convergence",
            humanReviewNote:
              "After 3 passes the auth test still fails intermittently; couldn't isolate the race.",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      // The reason heading matches the card's category marker word.
      expect(frame).toContain("non-convergence");
      // The note text renders in full (not truncated), alongside the body.
      expect(frame).toContain("couldn't isolate the race");
      // The body still renders beneath the header.
      expect(frame).toContain("The Issue body proper.");
    });

    it("shows the reason word that matches the card marker for each escalation reason", () => {
      for (const [reason, word] of [
        ["deviation", "deviation"],
        ["conflict", "conflict"],
        ["non-convergence", "non-convergence"],
      ] as const) {
        const { lastFrame } = render(
          <DetailModal
            detail={{
              title: "T",
              body: "body",
              humanReviewReason: reason,
              humanReviewNote: "why a human is needed",
            }}
          />,
        );
        expect(stripAnsi(lastFrame() ?? "")).toContain(word);
      }
    });

    it("renders no header for a non-human-review card — body only, unchanged", () => {
      const { lastFrame } = render(
        <DetailModal detail={{ title: "Plain", body: "Just the body." }} />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("Just the body.");
      // No escalation reason words leak into a plain card's detail view.
      expect(frame).not.toMatch(/deviation|conflict|non-convergence/);
    });

    it("renders no header when a reason is present but the note is absent", () => {
      // The header block is the reason+note pair; without a note there is nothing
      // to surface beyond the terse card marker, so the body shows alone.
      const { lastFrame } = render(
        <DetailModal
          detail={{ title: "T", body: "Body only.", humanReviewReason: "deviation" }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("Body only.");
      expect(frame).not.toContain("deviation");
    });

    it("renders the note even when the reason is absent (note is independent of reason)", () => {
      // The scanner lands a human_review_note independently of the reason — a
      // missing or unrecognized human_review_reason must not drop the note. With
      // no reason the header falls back to a neutral heading but the note shows.
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "T",
            body: "the body",
            humanReviewNote: "couldn't isolate the flake",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("human-review"); // neutral fallback heading
      expect(frame).toContain("couldn't isolate the flake"); // the note still surfaces
      expect(frame).toContain("the body");
    });

    it("renders the note verbatim, not reinterpreted as markdown", () => {
      // A note quoting agent output with markdown metacharacters (a bare ---, a
      // leading #, a fence) must read literally and must not collide with the
      // header/body --- separator or swallow the body into a code block.
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "T",
            body: "REAL_BODY_TEXT",
            humanReviewReason: "conflict",
            humanReviewNote: "diff showed\n---\n# FAIL\n```\nstack\n```",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      // The literal note characters survive…
      expect(frame).toContain("# FAIL");
      // …and the body is still reachable (a stray fence didn't swallow it).
      expect(frame).toContain("REAL_BODY_TEXT");
    });

    it("scrolls the note alongside the body rather than truncating it", () => {
      // A long multi-line note must be reachable by scrolling, not clipped to a
      // card-sized snippet. With the header composed into the scrollable stream, a
      // later window reveals note content that the first window clips.
      const longNote = Array.from({ length: 8 }, (_, i) => `NOTELINE${i}`).join("\n\n");
      const top = render(
        <DetailModal
          detail={{
            title: "T",
            body: "body",
            humanReviewReason: "conflict",
            humanReviewNote: longNote,
          }}
          scrollOffset={0}
          viewportRows={3}
        />,
      );
      expect(stripAnsi(top.lastFrame() ?? "")).toContain("NOTELINE0");

      // Scrolling to the end reaches the body, which sits beneath the whole note —
      // proof the note is fully traversable rather than clipped to a card snippet.
      const bottom = render(
        <DetailModal
          detail={{
            title: "T",
            body: "the body proper",
            humanReviewReason: "conflict",
            humanReviewNote: longNote,
          }}
          scrollOffset={99}
          viewportRows={3}
        />,
      );
      const bottomFrame = stripAnsi(bottom.lastFrame() ?? "");
      expect(bottomFrame).toContain("the body proper");
      expect(bottomFrame).not.toContain("NOTELINE0"); // the note's start scrolled off
    });
  });

  describe("tolerated header", () => {
    it("renders the tolerated marker and the waved-through reason above the body", () => {
      // The whole point of the fix: viewing a merged-with-tolerated Issue shows
      // *what* was tolerated, not just the board's presence-only marker.
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "Shipping label",
            body: "The Issue body proper.",
            reviewTolerated: "style:low — two unaddressed lint nits in the label formatter",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      // The marker word matches the card's `◌ tolerated` marker.
      expect(frame).toContain("tolerated");
      // The reason text — what was waved through — renders in full.
      expect(frame).toContain("two unaddressed lint nits");
      // The body still renders beneath the header.
      expect(frame).toContain("The Issue body proper.");
    });

    it("renders no tolerated header for a card without a reviewTolerated field", () => {
      const { lastFrame } = render(
        <DetailModal detail={{ title: "Plain", body: "Just the body." }} />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("Just the body.");
      expect(frame).not.toContain("tolerated");
    });

    it("renders both headers when an Issue carries an escalation and tolerated findings", () => {
      // A human-review Issue whose review converged clean-with-tolerated carries
      // both: the escalation reads first, the tolerated audit trail beneath it.
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "T",
            body: "REAL_BODY_TEXT",
            humanReviewReason: "deviation",
            humanReviewNote: "strayed from the planned approach",
            reviewTolerated: "style:low — a nit left in",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("deviation"); // escalation header
      expect(frame).toContain("strayed from the planned approach");
      expect(frame).toContain("tolerated"); // tolerated header
      expect(frame).toContain("a nit left in");
      expect(frame).toContain("REAL_BODY_TEXT"); // body beneath both
    });

    it("renders the tolerated reason verbatim, not reinterpreted as markdown", () => {
      // The reason quotes reviewer/agent output with markdown metacharacters — it
      // must read literally and not collide with the header/body --- separator.
      const { lastFrame } = render(
        <DetailModal
          detail={{
            title: "T",
            body: "REAL_BODY_TEXT",
            reviewTolerated: "left as-is\n---\n# NIT\n```\ndiff\n```",
          }}
        />,
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("# NIT");
      expect(frame).toContain("REAL_BODY_TEXT");
    });
  });
});
