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
  const board = useLiveBoard(props);
  return <Text>{board.prds[0]?.title ?? "(empty)"}</Text>;
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

  it("reconciles the reactor after the board rebuild on each change", async () => {
    let onChange = () => {};
    const order: string[] = [];
    const scan = vi.fn(() => {
      order.push("scan");
      return board("Updated");
    });
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };
    const reactor = {
      reconcile: vi.fn(() => order.push("reconcile")),
      setEnabled: vi.fn(),
      activity: vi.fn(() => "idle" as const),
    };

    render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={scan}
        watch={watch}
        reactor={reactor}
      />,
    );

    onChange();
    await tick();

    // The reactor reconciles, and only after the board has been re-scanned.
    expect(reactor.reconcile).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["scan", "reconcile"]);
  });

  it("fires onReconciled after each post-rebuild reconcile, in order", async () => {
    // The activity signal is owned by the caller (LiveApp), which re-reads the
    // Reactor in this callback. The hook's contract is just that it fires it after
    // the scan and reconcile, so the caller's read sees the fresh tally.
    let onChange = () => {};
    const order: string[] = [];
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };
    const reactor = {
      reconcile: vi.fn(() => order.push("reconcile")),
      setEnabled: vi.fn(),
      activity: vi.fn(() => "idle" as const),
    };
    const onReconciled = vi.fn(() => order.push("onReconciled"));

    render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={() => {
          order.push("scan");
          return board("Updated");
        }}
        watch={watch}
        reactor={reactor}
        onReconciled={onReconciled}
      />,
    );

    onChange();
    await tick();

    expect(onReconciled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["scan", "reconcile", "onReconciled"]);
  });

  it("works with no reactor wired (board-only tests)", async () => {
    let onChange = () => {};
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };

    expect(() => {
      render(
        <Probe
          root="/root"
          initialBoard={board("First")}
          scan={() => board("Updated")}
          watch={watch}
        />,
      );
      onChange();
    }).not.toThrow();
    await tick();
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
