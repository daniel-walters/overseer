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
  const { board } = useLiveBoard(props);
  return <Text>{board.prds[0]?.title ?? "(empty)"}</Text>;
}

/**
 * A probe that exposes the hook's `refresh` through a button-less seam: it calls
 * `onReady` with `refresh` on mount so the test can drive an on-demand re-scan
 * the way the App does after opening a PR (issue #66) — no FS event involved.
 */
function RefreshProbe(
  props: Parameters<typeof useLiveBoard>[0] & { onReady: (refresh: () => void) => void },
) {
  const { onReady, ...options } = props;
  const { board, refresh } = useLiveBoard(options);
  React.useEffect(() => onReady(refresh), [onReady, refresh]);
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

    // The reactor reconciles, and only after the board has been re-scanned; then
    // a second scan re-reads the post-flip disk state into the rendered board.
    expect(reactor.reconcile).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["scan", "reconcile", "scan"]);
  });

  it("reconciles the JIRA mirror with the freshly-scanned board after each change", async () => {
    let onChange = () => {};
    const scanned = board("Updated");
    const scan = vi.fn(() => scanned);
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };
    const mirror = { reconcile: vi.fn() };

    render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={scan}
        watch={watch}
        mirror={mirror}
      />,
    );

    onChange();
    await tick();

    // The mirror is handed exactly the board the scan produced (not a re-read).
    expect(mirror.reconcile).toHaveBeenCalledTimes(1);
    expect(mirror.reconcile).toHaveBeenCalledWith(scanned);
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
    expect(order).toEqual(["scan", "reconcile", "scan", "onReconciled"]);
  });

  it("re-scans after the reconcile so a flipped status surfaces in the same refresh", async () => {
    // The reconcile flips an Issue's status (e.g. ready-for-review → in-review on
    // the review-spawn edge) and writes it to disk. Without a post-reconcile
    // re-scan the flip only reaches the screen if that write round-trips as a
    // fresh watcher event — which FSEvents can coalesce or drop under a burst.
    // A single refresh (one watch callback) must render the post-flip board.
    let onChange = () => {};
    const scan = vi
      .fn<() => Board>()
      .mockReturnValueOnce(board("PreFlip")) // the pre-reconcile scan
      .mockReturnValue(board("PostFlip")); // the post-reconcile re-scan
    const watch = (_root: string, cb: () => void) => {
      onChange = cb;
      return () => {};
    };
    const reactor = {
      reconcile: vi.fn(), // a no-op stand-in for the status-flipping reconcile
      setEnabled: vi.fn(),
      activity: vi.fn(() => "idle" as const),
    };

    const { lastFrame } = render(
      <Probe
        root="/root"
        initialBoard={board("First")}
        scan={scan}
        watch={watch}
        reactor={reactor}
      />,
    );

    onChange(); // exactly one watch callback — no second FS event
    await tick();

    // The board reflects the post-reconcile scan, not the pre-flip one, off a
    // single refresh: scanned before AND after the reconcile.
    expect(scan).toHaveBeenCalledTimes(2);
    expect(reactor.reconcile).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("PostFlip");
  });

  it("scans only once for a board-only config (no reactor can flip a status)", async () => {
    // With no Reactor wired nothing can flip a status mid-refresh, so the extra
    // post-reconcile scan (and its liveness-probe fork) is pure waste: one scan
    // renders the board.
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

    onChange();
    await tick();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Updated");
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

  it("re-scans on demand when `refresh` is called, with no FS event", async () => {
    // The on-demand path the App drives after opening a PR: a GitHub write that
    // fires no FS event, so the watcher never re-scans (issue #66). `refresh` runs
    // the same rebuild the watcher would.
    let refresh = () => {};
    const scan = vi.fn(() => board("Updated"));

    const { lastFrame } = render(
      <RefreshProbe
        root="/root"
        initialBoard={board("First")}
        scan={scan}
        watch={() => () => {}}
        onReady={(r) => {
          refresh = r;
        }}
      />,
    );
    expect(lastFrame()).toContain("First");

    refresh();
    await tick();

    expect(scan).toHaveBeenCalledWith("/root");
    expect(lastFrame()).toContain("Updated");
  });

  it("runs the reactor reconcile and onReconciled on a `refresh` too", async () => {
    let refresh = () => {};
    const order: string[] = [];
    const reactor = {
      reconcile: vi.fn(() => order.push("reconcile")),
      setEnabled: vi.fn(),
      activity: vi.fn(() => "idle" as const),
    };
    const onReconciled = vi.fn(() => order.push("onReconciled"));

    render(
      <RefreshProbe
        root="/root"
        initialBoard={board("First")}
        scan={() => {
          order.push("scan");
          return board("Updated");
        }}
        watch={() => () => {}}
        reactor={reactor}
        onReconciled={onReconciled}
        onReady={(r) => {
          refresh = r;
        }}
      />,
    );

    refresh();
    await tick();

    expect(order).toEqual(["scan", "reconcile", "scan", "onReconciled"]);
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
