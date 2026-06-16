import { describe, it, expect, vi } from "vitest";
import {
  KEYBINDS,
  matchKeybind,
  type KeyPress,
  type KeybindHandlers,
} from "./keybinds.js";

/** A keypress as the input handler sees it: the typed input plus key flags. */
function press(input: string, key: Partial<KeyPress["key"]> = {}): KeyPress {
  return {
    input,
    key: { return: false, escape: false, upArrow: false, downArrow: false, ...key },
  };
}

/** A handlers bag of spies — every action the registry can invoke. */
function spyHandlers(): KeybindHandlers {
  return {
    move: vi.fn(),
    zoom: vi.fn(),
    back: vi.fn(),
    dispatch: vi.fn(),
    review: vi.fn(),
    redispatch: vi.fn(),
    kill: vi.fn(),
    goToPr: vi.fn(),
    toggleAutoRun: vi.fn(),
    showHelp: vi.fn(),
    quit: vi.fn(),
  };
}

describe("keybind registry", () => {
  it("is the single source of truth for key, label, and level", () => {
    // Every entry carries the three metadata fields both consumers read, plus an
    // action to invoke. No entry may omit them — that is what makes the help
    // modal and the input handler structurally agree.
    for (const b of KEYBINDS) {
      expect(typeof b.key).toBe("string");
      expect(b.key.length).toBeGreaterThan(0);
      expect(typeof b.label).toBe("string");
      expect(b.label.length).toBeGreaterThan(0);
      expect(["board", "issues", "both"]).toContain(b.level);
      expect(typeof b.action).toBe("function");
    }
  });

  it("lists every keybind exactly once (no duplicate key+level rows)", () => {
    const seen = new Set<string>();
    for (const b of KEYBINDS) {
      const id = `${b.key}@${b.level}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("matches a board-level binding only at the board level", () => {
    expect(matchKeybind(press("d"), "board")?.label).toContain("Dispatch");
    expect(matchKeybind(press("d"), "issues")).toBeUndefined();
  });

  it("matches an issue-level binding only at the issue level", () => {
    expect(matchKeybind(press("r"), "issues")?.label).toContain("Review");
    expect(matchKeybind(press("r"), "board")).toBeUndefined();
  });

  it("matches the go-to-PR binding only at the board level (PRDs carry the PR)", () => {
    // The Linked PR overlay lives on the PRD card, so `go to PR` is a board-level
    // gesture, the navigation sibling to `d`/`r` — never an Issue-level one.
    expect(matchKeybind(press("g"), "board")?.label).toContain("PR");
    expect(matchKeybind(press("g"), "issues")).toBeUndefined();
  });

  it("routes the go-to-PR binding to the goToPr handler", () => {
    const handlers = spyHandlers();
    const p = press("g");
    matchKeybind(p, "board")?.action(handlers, p);
    expect(handlers.goToPr).toHaveBeenCalledTimes(1);
  });

  it("matches a 'both'-level binding at either level", () => {
    expect(matchKeybind(press("a"), "board")?.label).toContain("auto-run");
    expect(matchKeybind(press("a"), "issues")?.label).toContain("auto-run");
  });

  it("matches movement keys (arrows and hjkl) as a 'both'-level binding", () => {
    expect(matchKeybind(press("j"), "board")?.label).toContain("Move");
    expect(matchKeybind(press("k"), "issues")?.label).toContain("Move");
    expect(matchKeybind(press("", { upArrow: true }), "board")?.label).toContain("Move");
    expect(matchKeybind(press("", { downArrow: true }), "issues")?.label).toContain("Move");
  });

  it("matches Enter (zoom) at the board level and Esc (back) at the issue level", () => {
    expect(matchKeybind(press("", { return: true }), "board")?.label).toContain("Zoom");
    expect(matchKeybind(press("", { escape: true }), "issues")?.label).toContain("Back");
  });

  it("returns the matched binding's action, which dispatches via the handlers bag", () => {
    const handlers = spyHandlers();
    const p = press("d");
    matchKeybind(p, "board")?.action(handlers, p);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes the auto-run binding to the toggle handler at either level", () => {
    const handlers = spyHandlers();
    const p = press("a");
    matchKeybind(p, "issues")?.action(handlers, p);
    expect(handlers.toggleAutoRun).toHaveBeenCalledTimes(1);
  });

  it("passes the keypress to the move action so it derives the right delta", () => {
    const handlers = spyHandlers();
    const down = press("j");
    matchKeybind(down, "board")?.action(handlers, down);
    expect(handlers.move).toHaveBeenCalledWith(1);

    const up = press("", { upArrow: true });
    matchKeybind(up, "issues")?.action(handlers, up);
    expect(handlers.move).toHaveBeenCalledWith(-1);
  });

  it("does not match an unbound key", () => {
    expect(matchKeybind(press("z"), "board")).toBeUndefined();
    expect(matchKeybind(press("z"), "issues")).toBeUndefined();
  });
});
