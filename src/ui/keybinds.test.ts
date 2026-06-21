import { describe, it, expect, vi } from "vitest";
import {
  KEYBINDS,
  matchKeybind,
  hintsFor,
  hintLabel,
  type KeyPress,
  type KeybindHandlers,
} from "./keybinds.js";
import type { BindContext } from "./eligibility.js";

/** A keypress as the input handler sees it: the typed input plus key flags. */
function press(input: string, key: Partial<KeyPress["key"]> = {}): KeyPress {
  return {
    input,
    key: {
      return: false,
      escape: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      ...key,
    },
  };
}

/**
 * A {@link BindContext} with every gated flag on, optionally overridden. The
 * matcher tests drive eligibility through these plain flags — never a real
 * frontier/liveness/`gh` seam — so the gate is exercised in isolation.
 */
function ctx(over: Partial<BindContext> = {}): BindContext {
  return {
    dispatchable: true,
    prdDone: true,
    prdHasPr: true,
    issueReadyForReview: true,
    issueReadyForHuman: true,
    issueOrphan: true,
    issueLive: true,
    issueApprovable: true,
    cardSelected: true,
    prdLane: "backlog",
    ...over,
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
    markDone: vi.fn(),
    approve: vi.fn(),
    openPr: vi.fn(),
    deletePrd: vi.fn(),
    goToPr: vi.fn(),
    toggleAutoRun: vi.fn(),
    viewDetail: vi.fn(),
    viewAgentOutput: vi.fn(),
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
    expect(matchKeybind(press("d"), "board", ctx())?.label).toContain("Dispatch");
    expect(matchKeybind(press("d"), "issues", ctx())).toBeUndefined();
  });

  it("matches an issue-level binding only at the issue level", () => {
    expect(matchKeybind(press("r"), "issues", ctx())?.label).toContain("Review");
    expect(matchKeybind(press("r"), "board", ctx())).toBeUndefined();
  });

  it("matches the mark-done binding only at the issue level (per-Issue, like r)", () => {
    expect(matchKeybind(press("m"), "issues", ctx())?.label).toContain("done");
    expect(matchKeybind(press("m"), "board", ctx())).toBeUndefined();
  });

  it("routes the mark-done binding to the markDone handler", () => {
    const handlers = spyHandlers();
    const p = press("m");
    matchKeybind(p, "issues", ctx())?.action(handlers, p);
    expect(handlers.markDone).toHaveBeenCalledTimes(1);
  });

  it("matches the approve binding only at the issue level (per-Issue, like r/m)", () => {
    expect(matchKeybind(press("A"), "issues", ctx())?.label).toContain("Approve");
    expect(matchKeybind(press("A"), "board", ctx())).toBeUndefined();
  });

  it("routes the approve binding to the approve handler", () => {
    const handlers = spyHandlers();
    const p = press("A");
    matchKeybind(p, "issues", ctx())?.action(handlers, p);
    expect(handlers.approve).toHaveBeenCalledTimes(1);
  });

  it("matches the go-to-PR binding only at the board level (PRDs carry the PR)", () => {
    // The Linked PR overlay lives on the PRD card, so `go to PR` is a board-level
    // gesture, the navigation sibling to `d`/`r` — never an Issue-level one.
    expect(matchKeybind(press("g"), "board", ctx())?.label).toContain("PR");
    expect(matchKeybind(press("g"), "issues", ctx())).toBeUndefined();
  });

  it("routes the go-to-PR binding to the goToPr handler", () => {
    const handlers = spyHandlers();
    const p = press("g");
    matchKeybind(p, "board", ctx())?.action(handlers, p);
    expect(handlers.goToPr).toHaveBeenCalledTimes(1);
  });

  it("matches the open-PR binding only at the board level (sibling to dispatch)", () => {
    // Open PR is a board-level, `done`-gated action like dispatch's `d`; the
    // registry gates the level and the eligibility predicate (done, no PR yet) —
    // the latter pinned here so this stays a level-gating check.
    const noPr = ctx({ prdDone: true, prdHasPr: false });
    expect(matchKeybind(press("P"), "board", noPr)?.label).toContain("PR");
    expect(matchKeybind(press("P"), "issues", noPr)).toBeUndefined();
  });

  it("routes the open-PR binding to the openPr handler", () => {
    const handlers = spyHandlers();
    const p = press("P");
    matchKeybind(p, "board", ctx({ prdDone: true, prdHasPr: false }))?.action(handlers, p);
    expect(handlers.openPr).toHaveBeenCalledTimes(1);
  });

  it("matches the delete binding only at the board level (whole-PRD, board-level)", () => {
    // Delete is a board-level, `done`-gated action like Open PR's `P`; the registry
    // gates only the level, the App-side handler gates the `done` column. It is
    // scoped to whole PRDs, never a single Issue, so it is inert when zoomed.
    expect(matchKeybind(press("X"), "board", ctx())?.label).toContain("Delete");
    expect(matchKeybind(press("X"), "issues", ctx())).toBeUndefined();
  });

  it("routes the delete binding to the deletePrd handler", () => {
    const handlers = spyHandlers();
    const p = press("X");
    matchKeybind(p, "board", ctx())?.action(handlers, p);
    expect(handlers.deletePrd).toHaveBeenCalledTimes(1);
  });

  it("matches a 'both'-level binding at either level", () => {
    expect(matchKeybind(press("a"), "board", ctx())?.label).toContain("auto-run");
    expect(matchKeybind(press("a"), "issues", ctx())?.label).toContain("auto-run");
  });

  it("matches the view-detail binding at either level (one gesture, both levels)", () => {
    // `v` reads the selected card's body — a PRD's at the board level, an Issue's
    // when zoomed — so it is a `both`-level binding like auto-run, not gated to one.
    expect(matchKeybind(press("v"), "board", ctx())?.label).toContain("body");
    expect(matchKeybind(press("v"), "issues", ctx())?.label).toContain("body");
  });

  it("routes the view-detail binding to the viewDetail handler", () => {
    const handlers = spyHandlers();
    const p = press("v");
    matchKeybind(p, "board", ctx())?.action(handlers, p);
    expect(handlers.viewDetail).toHaveBeenCalledTimes(1);
  });

  it("matches movement keys (arrows and hjkl) as a 'both'-level binding", () => {
    for (const k of ["h", "j", "k", "l"]) {
      expect(matchKeybind(press(k), "board", ctx())?.label).toContain("Move");
      expect(matchKeybind(press(k), "issues", ctx())?.label).toContain("Move");
    }
    expect(matchKeybind(press("", { upArrow: true }), "board", ctx())?.label).toContain("Move");
    expect(matchKeybind(press("", { downArrow: true }), "issues", ctx())?.label).toContain("Move");
    expect(matchKeybind(press("", { leftArrow: true }), "board", ctx())?.label).toContain("Move");
    expect(matchKeybind(press("", { rightArrow: true }), "issues", ctx())?.label).toContain("Move");
  });

  it("matches Enter (zoom) at the board level and Esc (back) at the issue level", () => {
    expect(matchKeybind(press("", { return: true }), "board", ctx())?.label).toContain("Zoom");
    expect(matchKeybind(press("", { escape: true }), "issues", ctx())?.label).toContain("Back");
  });

  it("aliases Enter to the detail view at the issue level (no deeper zoom to take)", () => {
    // Zoomed in, `Enter` opens the selected Issue's body just like `v` — it routes
    // to viewDetail, not zoom, and is gated on a selected card the same way `v` is.
    const enter = press("", { return: true });
    const at = matchKeybind(enter, "issues", ctx());
    expect(at?.label).toContain("body");
    const handlers = spyHandlers();
    at?.action(handlers, enter);
    expect(handlers.viewDetail).toHaveBeenCalledTimes(1);
    expect(handlers.zoom).not.toHaveBeenCalled();
    // Inert when nothing is selected, mirroring `v`.
    expect(matchKeybind(enter, "issues", ctx({ cardSelected: false }))).toBeUndefined();
  });

  it("returns the matched binding's action, which dispatches via the handlers bag", () => {
    const handlers = spyHandlers();
    const p = press("d");
    matchKeybind(p, "board", ctx())?.action(handlers, p);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes the auto-run binding to the toggle handler at either level", () => {
    const handlers = spyHandlers();
    const p = press("a");
    matchKeybind(p, "issues", ctx())?.action(handlers, p);
    expect(handlers.toggleAutoRun).toHaveBeenCalledTimes(1);
  });

  it("passes the keypress to the move action so it derives the right direction", () => {
    // hjkl and the arrows map onto the four spatial directions: ←/→ → h/l,
    // ↑/↓ → j/k. The four keys are all distinct — no two collapse onto one axis.
    const cases: ReadonlyArray<[KeyPress, "left" | "right" | "up" | "down"]> = [
      [press("h"), "left"],
      [press("l"), "right"],
      [press("k"), "up"],
      [press("j"), "down"],
      [press("", { leftArrow: true }), "left"],
      [press("", { rightArrow: true }), "right"],
      [press("", { upArrow: true }), "up"],
      [press("", { downArrow: true }), "down"],
    ];
    for (const [p, dir] of cases) {
      const handlers = spyHandlers();
      matchKeybind(p, "board", ctx())?.action(handlers, p);
      expect(handlers.move).toHaveBeenCalledWith(dir);
    }
  });

  it("does not match an unbound key", () => {
    expect(matchKeybind(press("z"), "board", ctx())).toBeUndefined();
    expect(matchKeybind(press("z"), "issues", ctx())).toBeUndefined();
  });
});

describe("matchKeybind — eligibility gate", () => {
  // The gate is exercised through plain BindContext flags, never a real seam: a
  // binding matches only when its level gate is open AND its `eligible` predicate
  // passes; an ineligible key falls through to no match and is genuinely inert.

  it("d matches when dispatchable and is inert when not (frontier-based)", () => {
    expect(matchKeybind(press("d"), "board", ctx({ dispatchable: true }))?.label).toContain(
      "Dispatch",
    );
    expect(matchKeybind(press("d"), "board", ctx({ dispatchable: false }))).toBeUndefined();
  });

  it("P matches only on a done PRD with no PR (mutually exclusive with go-to-PR)", () => {
    expect(
      matchKeybind(press("P"), "board", ctx({ prdDone: true, prdHasPr: false }))?.label,
    ).toContain("Open");
    // PR exists ⇒ P is inert (go-to-PR owns the done-with-PR case).
    expect(matchKeybind(press("P"), "board", ctx({ prdDone: true, prdHasPr: true }))).toBeUndefined();
    // Non-done ⇒ inert.
    expect(matchKeybind(press("P"), "board", ctx({ prdDone: false, prdHasPr: false }))).toBeUndefined();
  });

  it("go-to-PR matches only on a done PRD with a PR (mutually exclusive with P)", () => {
    expect(
      matchKeybind(press("g"), "board", ctx({ prdDone: true, prdHasPr: true }))?.label,
    ).toContain("PR");
    // No PR ⇒ go-to-PR is inert (P owns the done-no-PR case).
    expect(matchKeybind(press("g"), "board", ctx({ prdDone: true, prdHasPr: false }))).toBeUndefined();
    // Non-done ⇒ inert.
    expect(matchKeybind(press("g"), "board", ctx({ prdDone: false, prdHasPr: true }))).toBeUndefined();
  });

  it("X matches only on a done PRD", () => {
    expect(matchKeybind(press("X"), "board", ctx({ prdDone: true }))?.label).toContain("Delete");
    expect(matchKeybind(press("X"), "board", ctx({ prdDone: false }))).toBeUndefined();
  });

  it("r matches only on a ready-for-review Issue", () => {
    expect(
      matchKeybind(press("r"), "issues", ctx({ issueReadyForReview: true }))?.label,
    ).toContain("Review");
    expect(matchKeybind(press("r"), "issues", ctx({ issueReadyForReview: false }))).toBeUndefined();
  });

  it("m matches only on a ready-for-human Issue and is inert otherwise", () => {
    expect(
      matchKeybind(press("m"), "issues", ctx({ issueReadyForHuman: true }))?.label,
    ).toContain("done");
    expect(matchKeybind(press("m"), "issues", ctx({ issueReadyForHuman: false }))).toBeUndefined();
  });

  it("A matches only on an approvable human-review Issue and is inert otherwise", () => {
    expect(
      matchKeybind(press("A"), "issues", ctx({ issueApprovable: true }))?.label,
    ).toContain("Approve");
    expect(matchKeybind(press("A"), "issues", ctx({ issueApprovable: false }))).toBeUndefined();
  });

  it("R matches only on an orphaned Issue", () => {
    expect(matchKeybind(press("R"), "issues", ctx({ issueOrphan: true }))?.label).toContain(
      "orphan",
    );
    expect(matchKeybind(press("R"), "issues", ctx({ issueOrphan: false }))).toBeUndefined();
  });

  it("K matches only on a live Issue", () => {
    expect(matchKeybind(press("K"), "issues", ctx({ issueLive: true }))?.label).toContain("live");
    expect(matchKeybind(press("K"), "issues", ctx({ issueLive: false }))).toBeUndefined();
  });

  it("o matches only on a live Issue (the read twin of K's stop)", () => {
    // `o` reads a live agent's output — eligible on exactly the same `live` gate as
    // K, and inert on every other card (an agent that isn't running has nothing to
    // show, ADR 0023).
    expect(matchKeybind(press("o"), "issues", ctx({ issueLive: true }))?.label).toContain("output");
    expect(matchKeybind(press("o"), "issues", ctx({ issueLive: false }))).toBeUndefined();
  });

  it("o is an issue-level binding (never matches at the board level)", () => {
    expect(matchKeybind(press("o"), "board", ctx())).toBeUndefined();
  });

  it("routes the agent-output binding to the viewAgentOutput handler", () => {
    const handlers = spyHandlers();
    const p = press("o");
    matchKeybind(p, "issues", ctx())?.action(handlers, p);
    expect(handlers.viewAgentOutput).toHaveBeenCalledTimes(1);
  });

  it("v matches only when a card is selected", () => {
    expect(matchKeybind(press("v"), "board", ctx({ cardSelected: true }))?.label).toContain("body");
    expect(matchKeybind(press("v"), "board", ctx({ cardSelected: false }))).toBeUndefined();
  });

  it("always-eligible keys ignore the context entirely", () => {
    // Movement / Enter / Esc / a / ? / q carry no `eligible`, so they match even
    // when every gated flag is off — navigation and global switches are never
    // gated away.
    const none = ctx({
      dispatchable: false,
      prdDone: false,
      prdHasPr: false,
      issueReadyForReview: false,
      issueReadyForHuman: false,
      issueOrphan: false,
      issueLive: false,
      cardSelected: false,
    });
    expect(matchKeybind(press("k"), "board", none)?.label).toContain("Move");
    expect(matchKeybind(press("", { return: true }), "board", none)?.label).toContain("Zoom");
    expect(matchKeybind(press("", { escape: true }), "issues", none)?.label).toContain("Back");
    expect(matchKeybind(press("a"), "board", none)?.label).toContain("auto-run");
    expect(matchKeybind(press("?"), "board", none)?.label).toContain("help");
    expect(matchKeybind(press("q"), "board", none)?.label).toContain("Quit");
  });

  it("a binding with no eligible predicate is always eligible", () => {
    // Structural: every entry either carries an `eligible` function or none at all
    // (an absent predicate ⇒ always eligible), never some other shape.
    for (const b of KEYBINDS) {
      if (b.eligible !== undefined) expect(typeof b.eligible).toBe("function");
    }
  });
});

describe("hintsFor — the status-line subset, eligibility-filtered", () => {
  // The bottom bar renders from the registry filtered by eligibility (ADR 0017),
  // not a hardcoded list. `hintsFor` is the pure selector both the bar and these
  // tests read: the hint-flagged bindings active at the level whose `eligible`
  // predicate passes for the context. The keys it returns are exactly the keys the
  // bar shows. Driven through plain BindContext flags, never a real seam.

  const keysOf = (level: "board" | "issues", c: BindContext): string[] =>
    hintsFor(level, c).map((b) => b.key);

  it("shows a done PRD with no PR exactly P and X (and ?), not g or d", () => {
    const c = ctx({
      dispatchable: false,
      prdDone: true,
      prdHasPr: false,
    });
    const keys = keysOf("board", c);
    expect(keys).toContain("P");
    expect(keys).toContain("X");
    expect(keys).toContain("?");
    expect(keys).not.toContain("g");
    expect(keys).not.toContain("d");
  });

  it("shows a done PRD with a PR exactly g and X (and ?), not P", () => {
    const c = ctx({
      dispatchable: false,
      prdDone: true,
      prdHasPr: true,
    });
    const keys = keysOf("board", c);
    expect(keys).toContain("g");
    expect(keys).toContain("X");
    expect(keys).not.toContain("P");
    expect(keys).not.toContain("d");
  });

  it("shows d on an in-progress PRD with dispatchable work (resume), but no done-only keys", () => {
    const c = ctx({
      dispatchable: true,
      prdDone: false,
      prdHasPr: false,
    });
    const keys = keysOf("board", c);
    expect(keys).toContain("d");
    expect(keys).not.toContain("P");
    expect(keys).not.toContain("g");
    expect(keys).not.toContain("X");
  });

  it("hides d on a PRD with no dispatchable work (empty wave never advertised)", () => {
    const c = ctx({ dispatchable: false, prdDone: false });
    expect(keysOf("board", c)).not.toContain("d");
  });

  it("shows the issue-level action keys only where their state matches", () => {
    expect(keysOf("issues", ctx({ issueReadyForReview: true, issueOrphan: false, issueLive: false }))).toContain("r");
    expect(keysOf("issues", ctx({ issueReadyForReview: false }))).not.toContain("r");
    expect(keysOf("issues", ctx({ issueOrphan: true, issueReadyForReview: false, issueLive: false }))).toContain("R");
    expect(keysOf("issues", ctx({ issueOrphan: false }))).not.toContain("R");
    expect(keysOf("issues", ctx({ issueLive: true, issueReadyForReview: false, issueOrphan: false }))).toContain("K");
    expect(keysOf("issues", ctx({ issueLive: false }))).not.toContain("K");
    expect(keysOf("issues", ctx({ issueLive: true, issueReadyForReview: false, issueOrphan: false }))).toContain("o");
    expect(keysOf("issues", ctx({ issueLive: false }))).not.toContain("o");
    expect(keysOf("issues", ctx({ issueReadyForHuman: true }))).toContain("m");
    expect(keysOf("issues", ctx({ issueReadyForHuman: false }))).not.toContain("m");
    expect(keysOf("issues", ctx({ issueApprovable: true }))).toContain("A");
    expect(keysOf("issues", ctx({ issueApprovable: false }))).not.toContain("A");
  });

  it("never offers board-only keys at the issue level, or issue-only keys at the board level", () => {
    const all = ctx();
    const boardKeys = keysOf("board", all);
    const issueKeys = keysOf("issues", all);
    // Issue-level action keys never leak onto the board bar.
    for (const k of ["r", "R", "K", "m", "A", "o"]) expect(boardKeys).not.toContain(k);
    // Board-only PRD keys never leak onto the issue bar.
    for (const k of ["d", "P", "g", "X"]) expect(issueKeys).not.toContain(k);
  });

  it("always keeps ? regardless of selection (the always-on learning pointer)", () => {
    const none = ctx({
      dispatchable: false,
      prdDone: false,
      prdHasPr: false,
      issueReadyForReview: false,
      issueReadyForHuman: false,
      issueOrphan: false,
      issueLive: false,
      cardSelected: false,
    });
    expect(keysOf("board", none)).toContain("?");
    expect(keysOf("issues", none)).toContain("?");
  });

  it("does not clutter the bar with the navigation keys (movement / Enter / Esc / a / q)", () => {
    // These always-on keys belong in `?`, not the bottom bar — the bar is a signal
    // of the *actionable* keys for the selection, not the whole map.
    const keys = keysOf("board", ctx());
    for (const k of ["h j k l / arrows", "Enter", "a", "q"]) {
      expect(keys).not.toContain(k);
    }
  });
});

describe("hintLabel — d's context-aware dispatch/resume label (ADR 0017)", () => {
  // `d` is the lone binding with a `labelFor(ctx)` override, consulted by the
  // status-line hints only. Its hint reads "dispatch" on a backlog PRD (first
  // ignition) and "resume" on an in-progress PRD (re-dispatching newly-unblocked
  // work — the manual crank when auto-run is off). Every other binding keeps its
  // plain static label. The `?` help map never consults `labelFor` (a separate
  // completeness test locks that).

  const d = KEYBINDS.find((b) => b.key === "d");
  if (d === undefined) throw new Error("the d binding must exist");

  it("reads 'dispatch' when the selected PRD's lane is backlog", () => {
    expect(hintLabel(d, ctx({ prdLane: "backlog" })).toLowerCase()).toContain("dispatch");
    expect(hintLabel(d, ctx({ prdLane: "backlog" })).toLowerCase()).not.toContain("resume");
  });

  it("reads 'resume' when the selected PRD's lane is in-progress", () => {
    expect(hintLabel(d, ctx({ prdLane: "in-progress" })).toLowerCase()).toContain("resume");
    expect(hintLabel(d, ctx({ prdLane: "in-progress" })).toLowerCase()).not.toContain("dispatch");
  });

  it("falls back to the static label for every binding without a labelFor", () => {
    // Only `d` carries `labelFor`; the rest must resolve to their plain `label`
    // regardless of context, so no other key gains a dynamic label.
    for (const b of KEYBINDS) {
      if (b.key === "d") continue;
      expect(hintLabel(b, ctx())).toBe(b.label);
    }
  });

  it("only the d binding defines a labelFor override", () => {
    const withLabelFor = KEYBINDS.filter((b) => b.labelFor !== undefined);
    expect(withLabelFor.map((b) => b.key)).toEqual(["d"]);
  });
});
