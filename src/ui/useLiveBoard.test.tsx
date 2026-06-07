import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useLiveBoard } from "./useLiveBoard.js";
import type { Board } from "../model.js";

const board = (title: string): Board => ({
  prds: [{ id: "p", title, lane: "backlog", issues: [] }],
});

/** A tiny probe component that renders the live board's first PRD title. */
function Probe(props: Parameters<typeof useLiveBoard>[0]) {
  const live = useLiveBoard(props);
  return <Text>{live.prds[0]?.title ?? "(empty)"}</Text>;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("useLiveBoard", () => {
  it("starts from the initial board", () => {
    const { lastFrame } = render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={() => board("First")}
        watch={() => () => {}}
      />,
    );

    expect(lastFrame()).toContain("First");
  });

  it("re-scans and re-renders when the watcher reports a change", async () => {
    let onChange = () => {};
    const scan = vi.fn(() => board("Updated"));
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };

    const { lastFrame } = render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={scan}
        watch={watch}
      />,
    );
    expect(lastFrame()).toContain("First");

    onChange(); // the debounced watcher fires
    await tick();

    expect(scan).toHaveBeenCalledWith("/root");
    expect(lastFrame()).toContain("Updated");
  });

  it("tears down the watcher on unmount", () => {
    const teardown = vi.fn();
    const watch = () => teardown;

    const { unmount } = render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={() => board("First")}
        watch={watch}
      />,
    );

    unmount();

    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
