import { describe, it, expect } from "vitest";
import { renderForTest as render } from "./renderForTest.js";
import { Column } from "./Column.js";
import type { CardItem } from "./Column.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const frameOf = (el: React.ReactElement): string =>
  stripAnsi(render(el).lastFrame() ?? "");

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
      <Column heading="Backlog" cards={cards(4)} availableHeight={10} />,
    );

    for (let i = 0; i < 4; i++) {
      expect(frame).toContain(`Card-${i}`);
    }
  });

  it("renders all cards when no available height is given (unbounded)", () => {
    // Absent height means no windowing — the prior behaviour, used by tests and
    // any caller that hasn't wired the environmental read.
    const frame = frameOf(<Column heading="Backlog" cards={cards(30)} />);

    expect(frame).toContain("Card-0");
    expect(frame).toContain("Card-29");
  });

  it("renders only its visible window when the lane overflows", () => {
    // 20 cards, room for 5: the column must not render all 20.
    const frame = frameOf(
      <Column
        heading="Backlog"
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
    const frame = frameOf(
      <Column
        heading="Backlog"
        cards={cards(20)}
        availableHeight={5}
        selectedRow={17}
        selectedId="c17"
      />,
    );

    // The selected card and its neighbours are visible…
    expect(frame).toContain("Card-17");
    // …the selection highlight sits on it…
    expect(frame).toMatch(/▶ Card-17/);
    // …and the top of the lane has scrolled away.
    expect(frame).not.toContain("Card-0");
  });

  it("highlights the selected row inside its window and no other", () => {
    const frame = frameOf(
      <Column
        heading="Backlog"
        cards={cards(20)}
        availableHeight={5}
        selectedRow={10}
        selectedId="c10"
      />,
    );

    expect(frame).toMatch(/▶ Card-10/);
    expect(frame.match(/▶/g)?.length).toBe(1);
  });

  it("shows the bottom of the lane when the last row is selected", () => {
    const frame = frameOf(
      <Column
        heading="Backlog"
        cards={cards(20)}
        availableHeight={5}
        selectedRow={19}
        selectedId="c19"
      />,
    );

    expect(frame).toContain("Card-19");
    expect(frame).toMatch(/▶ Card-19/);
    expect(frame).not.toContain("Card-0");
  });

  it("windows from the top of an unselected overflowing lane", () => {
    // A lane the selection isn't in (no selectedRow) still windows — it just
    // shows its top, so the board never renders every card of every tall column.
    const frame = frameOf(
      <Column heading="Backlog" cards={cards(20)} availableHeight={5} />,
    );

    expect(frame).toContain("Card-0");
    expect(frame).not.toContain("Card-19");
  });
});
