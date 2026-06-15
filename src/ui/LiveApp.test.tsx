import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { LiveApp } from "./LiveApp.js";
import type { Board } from "../model.js";
import type { Reactor } from "../reactor/reactor.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");
const tick = () => new Promise((r) => setTimeout(r, 20));

const makeBoard = (): Board => ({
  prds: [
    {
      id: "auth",
      title: "AuthPRD",
      lane: "backlog",
      issues: [
        { id: "010-login", title: "Login", lane: "backlog" },
        { id: "020-oauth", title: "OAuth", lane: "in-progress" },
      ],
    },
    {
      id: "billing",
      title: "BillPRD",
      lane: "backlog",
      issues: [{ id: "010-invoice", title: "Invoice", lane: "backlog" }],
    },
  ],
});

describe("LiveApp", () => {
  it("re-scans on a watcher change while preserving the current zoom level", async () => {
    let onChange = () => {};
    // The re-scan returns a board where one of the zoomed PRD's Issues is gone
    // (its file was deleted) — the card should disappear live.
    const rescanned: Board = {
      prds: [
        {
          id: "auth",
          title: "AuthPRD",
          lane: "backlog",
          issues: [{ id: "020-oauth", title: "OAuth", lane: "in-progress" }],
        },
        {
          id: "billing",
          title: "BillPRD",
          lane: "backlog",
          issues: [{ id: "010-invoice", title: "Invoice", lane: "backlog" }],
        },
      ],
    };

    const { stdin, lastFrame } = render(
      <LiveApp
        root="/root"
        initialBoard={makeBoard()}
        scan={() => rescanned}
        watch={(_r, cb) => {
          onChange = cb;
          return () => {};
        }}
      />,
    );

    stdin.write(ENTER); // zoom into AuthPRD's Issues
    await tick();
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Login");
    expect(frame).toContain("OAuth");

    onChange(); // Login's file was deleted on disk
    await tick();

    frame = stripAnsi(lastFrame() ?? "");
    // Still zoomed into AuthPRD (not bounced back to the board level)…
    expect(frame).toContain("AuthPRD");
    expect(frame).not.toContain("BillPRD");
    // …and the deletion is reflected live: Login's card is gone, OAuth remains.
    expect(frame).not.toContain("Login");
    expect(frame).toContain("OAuth");
  });

  it("starts with auto-run on and toggles the Reactor off on `a`", async () => {
    const reactor: Reactor = {
      reconcile: vi.fn(),
      setEnabled: vi.fn(),
      activity: vi.fn(() => "idle" as const),
    };

    const { stdin, lastFrame } = render(
      <LiveApp
        root="/root"
        initialBoard={makeBoard()}
        scan={() => makeBoard()}
        watch={() => () => {}}
        reactor={reactor}
      />,
    );

    // On by default.
    expect(stripAnsi(lastFrame() ?? "")).toContain("auto-run on");

    stdin.write("a");
    await tick();

    // The Reactor was told to disable, and the indicator flipped.
    expect(reactor.setEnabled).toHaveBeenCalledWith(false);
    expect(stripAnsi(lastFrame() ?? "")).toContain("auto-run off");

    stdin.write("a");
    await tick();

    // Toggling back on re-enables the Reactor (which itself catch-up reconciles).
    expect(reactor.setEnabled).toHaveBeenCalledWith(true);
    expect(stripAnsi(lastFrame() ?? "")).toContain("auto-run on");
  });

  it("surfaces the Reactor's activity signal on the status line", async () => {
    // The board-level idle/working/at-rest signal is read off the live Reactor and
    // threaded to the status line beside the auto-run indicator (Issue: surface
    // reactor state). It reflects the Reactor's current in-memory state on each
    // render, so it updates as the Reactor's activity changes.
    let current: "idle" | "working" = "idle";
    const reactor: Reactor = {
      reconcile: vi.fn(),
      setEnabled: vi.fn(),
      activity: vi.fn(() => current),
    };

    let onChange = () => {};
    const { lastFrame } = render(
      <LiveApp
        root="/root"
        initialBoard={makeBoard()}
        scan={() => makeBoard()}
        watch={(_r, cb) => {
          onChange = cb;
          return () => {};
        }}
        reactor={reactor}
      />,
    );

    // Idle to begin with: on, nothing spawning.
    expect(stripAnsi(lastFrame() ?? "")).toContain("idle");

    // A rebuild reconciles the Reactor, which now reports working; the next render
    // reflects the new signal.
    current = "working";
    onChange();
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("working");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("idle");
  });

  it("renders no activity signal when no Reactor is wired", () => {
    // Board-only render (no reactor): the activity half of the status line is
    // empty, just like the auto-run indicator, never a phantom default.
    const { lastFrame } = render(
      <LiveApp
        root="/root"
        initialBoard={makeBoard()}
        scan={() => makeBoard()}
        watch={() => () => {}}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("working");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("at-rest");
  });
});
