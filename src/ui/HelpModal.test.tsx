import { describe, it, expect } from "vitest";
import React from "react";
import { renderForTest as render } from "./renderForTest.js";
import { HelpModal } from "./HelpModal.js";
import { KEYBINDS } from "./keybinds.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

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
