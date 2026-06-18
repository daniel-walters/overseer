import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { Column } from "./Column.js";
import type { CardItem } from "./Column.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const frameOf = (el: React.ReactElement): string =>
  stripAnsi(render(el).lastFrame() ?? "");

// The raw (ANSI-bearing) frame, for asserting the selection cue — a card's
// border flipping to magenta plus a bold inverse title bar (issue #75; no ▶
// pointer, see Card.test.tsx), which live in SGR codes `frameOf` strips away.
const rawFrameOf = (el: React.ReactElement): string =>
  render(el).lastFrame() ?? "";

// The SGR code Ink emits for a magenta foreground (the selected card's border).
const MAGENTA = ESC + "[35m";

/** A run of distinctly-titled cards (`Card-0`, `Card-1`, …) to window over. */
function cards(n: number): CardItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title: `Card-${i}`,
  }));
}

describe("Column visible window (vertical scroll)", () => {
  it("renders every card when the lane fits the available height", () => {
    const frame = frameOf(
      <Column heading="Backlog" width={20} cards={cards(4)} availableHeight={10} />,
    );

    for (let i = 0; i < 4; i++) {
      expect(frame).toContain(`Card-${i}`);
    }
  });

  it("renders all cards when no available height is given (unbounded)", () => {
    // Absent height means no windowing — the prior behaviour, used by tests and
    // any caller that hasn't wired the environmental read.
    const frame = frameOf(<Column heading="Backlog" width={20} cards={cards(30)} />);

    expect(frame).toContain("Card-0");
    expect(frame).toContain("Card-29");
  });

  it("renders only its visible window when the lane overflows", () => {
    // 20 cards, room for 5: the column must not render all 20.
    const frame = frameOf(
      <Column
        heading="Backlog"
        width={20}
        cards={cards(20)}
        availableHeight={5}
        selectedRow={0}
      />,
    );

    // The top of the lane is shown…
    expect(frame).toContain("Card-0");
    // …and the far end is windowed out, not clipped-but-present.
    expect(frame).not.toContain("Card-19");
    expect(frame).not.toContain("Card-15");
  });

  it("scrolls the window to keep the selected row in view", () => {
    // Selecting a row past the bottom of the top window scrolls it into view.
    const raw = rawFrameOf(
      <Column
        heading="Backlog"
        width={20}
        cards={cards(20)}
        availableHeight={5}
        selectedRow={17}
        selectedId="c17"
      />,
    );

    // The selected card and its neighbours are visible…
    expect(stripAnsi(raw)).toContain("Card-17");
    // …the selection highlight (the magenta border cue) is present…
    expect(raw).toContain(MAGENTA);
    // …and the top of the lane has scrolled away.
    expect(stripAnsi(raw)).not.toContain("Card-0");
  });

  it("highlights the selected row inside its window and no other", () => {
    const raw = rawFrameOf(
      <Column
        heading="Backlog"
        width={20}
        cards={cards(20)}
        availableHeight={5}
        selectedRow={10}
        selectedId="c10"
      />,
    );

    // The selected card (Card-10) is inside the window, and the magenta border —
    // the selection cue — marks exactly one card. Ink emits the magenta SGR
    // once per bordered line of a selected card's box, so a single selected
    // card's worth of magenta runs is the "and no other" invariant.
    expect(stripAnsi(raw)).toContain("Card-10");
    const magentaRuns = (raw.match(new RegExp(ESC + "\\[35m", "g")) ?? []).length;
    const oneCardMagentaRuns = (
      rawFrameOf(
        <Column heading="Backlog" width={20} cards={cards(1)} selectedRow={0} selectedId="c0" />,
      ).match(new RegExp(ESC + "\\[35m", "g")) ?? []
    ).length;
    expect(magentaRuns).toBe(oneCardMagentaRuns);
  });

  it("shows the bottom of the lane when the last row is selected", () => {
    const raw = rawFrameOf(
      <Column
        heading="Backlog"
        width={20}
        cards={cards(20)}
        availableHeight={5}
        selectedRow={19}
        selectedId="c19"
      />,
    );

    // The last card is in view, carries the magenta-border selection cue, and the
    // top of the lane has scrolled away.
    expect(stripAnsi(raw)).toContain("Card-19");
    expect(raw).toContain(MAGENTA);
    expect(stripAnsi(raw)).not.toContain("Card-0");
  });

  it("windows from the top of an unselected overflowing lane", () => {
    // A lane the selection isn't in (no selectedRow) still windows — it just
    // shows its top, so the board never renders every card of every tall column.
    const frame = frameOf(
      <Column heading="Backlog" width={20} cards={cards(20)} availableHeight={5} />,
    );

    expect(frame).toContain("Card-0");
    expect(frame).not.toContain("Card-19");
  });
});
