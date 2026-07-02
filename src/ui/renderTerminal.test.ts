import { describe, it, expect } from "vitest";
import { renderTerminal } from "./renderTerminal.js";

/**
 * The renderer is the deep module behind ADR 0030: raw `claude logs` TTY-replay
 * bytes in, the resolved cols×rows screen out as clean lines. These tests assert on
 * the *reconstructed screen* a real terminal would show — not on the escape handling
 * step by step — feeding representative raw byte fixtures and checking the lines.
 */
describe("renderTerminal (raw TTY replay → resolved screen lines)", () => {
  it("collapses a carriage-return in-place overwrite to the final line", async () => {
    // A progress bar redraws the same line with `\r`; only the last frame survives.
    const lines = await renderTerminal(
      "Progress: 10%\rProgress: 55%\rProgress: 100%\n",
      80,
      24,
    );
    expect(lines).toEqual(["Progress: 100%"]);
  });

  it("resolves a cursor-up spinner redraw to a single current line", async () => {
    // A spinner prints a frame, moves the cursor back up, and overwrites it. The
    // stacked frames must collapse to the one line the terminal currently shows.
    const spinner =
      "⠋ Metamorphosing…\n\x1b[1A\r⠙ Metamorphosing…\n\x1b[1A\r⠹ Metamorphosing…\n";
    const lines = await renderTerminal(spinner, 80, 24);
    expect(lines).toEqual(["⠹ Metamorphosing…"]);
  });

  it("passes plain multi-line text through unchanged and legibly", async () => {
    const lines = await renderTerminal("line one\nline two\nline three\n", 80, 24);
    expect(lines).toEqual(["line one", "line two", "line three"]);
  });

  it("renders the verbatim \"No job matching\" message unchanged", async () => {
    // ADR 0023's race message is plain text an emulator renders verbatim.
    const msg = 'No job matching "abc123" found\n';
    const lines = await renderTerminal(msg, 80, 24);
    expect(lines).toEqual(['No job matching "abc123" found']);
  });

  it("yields no real content for empty input", async () => {
    expect(await renderTerminal("", 80, 24)).toEqual([]);
  });

  it("yields no real content for whitespace-only input (placeholder still fires)", async () => {
    // The modal's `(no output yet)` placeholder keys off there being no non-blank
    // line, so whitespace-only bytes must resolve to nothing real.
    const lines = await renderTerminal("   \n\n  \n", 80, 24);
    expect(lines.every((l) => l.trim().length === 0)).toBe(true);
  });

  it("wraps a line wider than cols to the given width", async () => {
    // No original width is recorded in the stream, so the emulator wraps at `cols`.
    const lines = await renderTerminal("X".repeat(25) + "\n", 10, 6);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(10);
    expect(lines.join("")).toBe("X".repeat(25));
  });

  it("preserves content taller than the grid via scrollback (so the modal can scroll)", async () => {
    const tall =
      Array.from({ length: 60 }, (_, i) => `LINE${i}`).join("\n") + "\n";
    const lines = await renderTerminal(tall, 80, 10);
    expect(lines[0]).toBe("LINE0");
    expect(lines[lines.length - 1]).toBe("LINE59");
    expect(lines.length).toBe(60);
  });
});
