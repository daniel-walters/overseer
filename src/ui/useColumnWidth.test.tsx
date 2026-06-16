import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { renderForTest } from "./renderForTest.js";
import { useColumnWidth } from "./useColumnWidth.js";

/** A probe that renders only the width the hook produces, for assertion. */
function WidthProbe({ columnCount }: { columnCount: number }) {
  const width = useColumnWidth(columnCount);
  return <Text>width={width}</Text>;
}

/** Let Ink flush the resize event and re-render. */
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("useColumnWidth", () => {
  it("feeds the live terminal width through the pure distribution", () => {
    // 240 cols / 3 = 80, above the floor.
    const { lastFrame } = renderForTest(<WidthProbe columnCount={3} />, 240);
    expect(lastFrame()).toContain("width=80");
  });

  it("distributes the same terminal width differently per column count", () => {
    // 420 / 3 = 140 board-level; 420 / 7 = 60 zoomed — different widths out.
    const board = renderForTest(<WidthProbe columnCount={3} />, 420);
    expect(board.lastFrame()).toContain("width=140");

    const zoomed = renderForTest(<WidthProbe columnCount={7} />, 420);
    expect(zoomed.lastFrame()).toContain("width=60");
  });

  it("holds at the floor on a narrow terminal", () => {
    // 60 / 3 = 20, below the 24 floor.
    const { lastFrame } = renderForTest(<WidthProbe columnCount={3} />, 60);
    expect(lastFrame()).toContain("width=24");
  });

  it("re-distributes when the terminal resizes", async () => {
    const { lastFrame, resize } = renderForTest(<WidthProbe columnCount={3} />, 240);
    expect(lastFrame()).toContain("width=80");

    resize(60); // shrink below the floor
    await tick();
    expect(lastFrame()).toContain("width=24");

    resize(420); // grow wide
    await tick();
    expect(lastFrame()).toContain("width=140");
  });
});
