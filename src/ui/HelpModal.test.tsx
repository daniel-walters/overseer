import { describe, it, expect } from "vitest";
import React from "react";
import { renderForTest as render } from "./renderForTest.js";
import { HelpModal } from "./HelpModal.js";
import { KEYBINDS, matchKeybind, type KeyPress } from "./keybinds.js";
import type { BindContext } from "./eligibility.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

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
 * A {@link BindContext} with every gated flag **off**: nothing is dispatchable,
 * the PRD isn't done and has no PR, the Issue isn't review-ready / orphaned /
 * live, and no card is selected. Under this context every action keybind that
 * carries an `eligible` predicate is inert in the matcher — exactly the context
 * a contextual `?` would use to *hide* those keys.
 */
const NOTHING_ELIGIBLE: BindContext = {
  dispatchable: false,
  prdDone: false,
  prdHasPr: false,
  issueReadyForReview: false,
  issueOrphan: false,
  issueLive: false,
  cardSelected: false,
  prdLane: undefined,
};

describe("HelpModal — the deliberate eligibility exception (ADR 0017)", () => {
  it("lists EVERY registered keybind regardless of eligibility", () => {
    // The `?` reference answers "what keys exist and where?", a learning surface —
    // not "what can I do right now?". So unlike the matcher and the status-line
    // hints, it never filters by eligibility: every key in the registry, including
    // ones that are inert on the current selection, must appear. A test locks this
    // so a future change can't silently make `?` contextual.
    const { lastFrame } = render(<HelpModal />);
    const frame = stripAnsi(lastFrame() ?? "");

    for (const b of KEYBINDS) {
      expect(frame).toContain(b.key);
      expect(frame).toContain(b.label);
    }
  });

  it("keeps inert keys in the map when fed an eligibility context (locks the asymmetry)", () => {
    // The strongest form of the ADR-0017 exception: completeness is *independent*
    // of eligibility. Feed a context that makes every gated action key inert in the
    // matcher, then assert those same keys still appear in the rendered help. This
    // pins help and matcher in deliberate disagreement — so a future change that
    // routes `?` through the eligibility filter (as the matcher and hints are)
    // would drop the inert keys from the frame and fail here.
    const { lastFrame } = render(<HelpModal />);
    const frame = stripAnsi(lastFrame() ?? "");

    // The gated action bindings, each verified inert under NOTHING_ELIGIBLE at the
    // level it lives on — so the help map is showing keys the matcher refuses.
    const gated: ReadonlyArray<[KeyPress, "board" | "issues", string]> = [
      [press("d"), "board", "Dispatch a wave"],
      [press("P"), "board", "Open a PR for a done PRD"],
      [press("X"), "board", "Delete a done PRD"],
      [press("g"), "board", "Go to the selected PRD's PR"],
      [press("r"), "issues", "Review the selected Issue"],
      [press("R"), "issues", "Re-dispatch an orphaned Issue"],
      [press("K"), "issues", "Stop a live Issue's agent"],
      [press("v"), "board", "View the selected card's body"],
    ];

    for (const [p, level, label] of gated) {
      // Inert in the matcher under this context...
      expect(matchKeybind(p, level, NOTHING_ELIGIBLE)).toBeUndefined();
      // ...yet still listed in the help map.
      expect(frame).toContain(label);
    }
  });

  it("shows d's static label and never its context-aware hint override", () => {
    // `d` is the lone binding with a `labelFor` (dispatch vs resume by lane), but
    // that override is for the status-line hints only (ADR 0017): help has no live
    // selection to key a dynamic label off, so it keeps the static "Dispatch a
    // wave" and must never surface the "Resume a wave" hint wording. Locks the
    // help-vs-hints label asymmetry so a future change can't route `?` through
    // `labelFor`.
    const { lastFrame } = render(<HelpModal />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Dispatch a wave");
    expect(frame).not.toContain("Resume a wave");
  });

  it("renders each key's level context (board / issues / both)", () => {
    // The level tag is part of "where does this key work?" — a learning cue the
    // hints don't carry. Every registered level string must show somewhere.
    const { lastFrame } = render(<HelpModal />);
    const frame = stripAnsi(lastFrame() ?? "");

    for (const b of KEYBINDS) {
      expect(frame).toContain(`(${b.level})`);
    }
  });
});
