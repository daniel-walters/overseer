import { describe, it, expect } from "vitest";
import { parseHandle } from "./handle.js";

/**
 * The handle parser is pure (stdout string → handle | undefined), so it is
 * tested with literal stdout fixtures and no I/O. It isolates the one brittle
 * thing — reading Claude's human-facing `backgrounded · <handle>` launch line —
 * so that the parse (and its malformed-input handling) is independently
 * verifiable (ADR 0008: "the parse breaks if Claude changes that line").
 */
describe("parseHandle", () => {
  it("extracts the handle from a well-formed `backgrounded · <handle>` line", () => {
    expect(parseHandle("backgrounded · abc123")).toBe("abc123");
  });

  it("extracts the handle when the line is surrounded by noise", () => {
    const stdout = [
      "Starting agent…",
      "backgrounded · session-7f3a",
      "Run `claude agents` to view it.",
    ].join("\n");
    expect(parseHandle(stdout)).toBe("session-7f3a");
  });

  it("returns undefined for stdout with no backgrounded line", () => {
    expect(parseHandle("some unrelated output\nmore lines")).toBeUndefined();
  });

  it("returns undefined for empty stdout", () => {
    expect(parseHandle("")).toBeUndefined();
  });
});
