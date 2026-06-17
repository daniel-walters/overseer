import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DeletePreview } from "./DeletePreview.js";
import type { DeletePreviewData } from "../dispatch/deletePrd.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function preview(overrides: Partial<DeletePreviewData> = {}): DeletePreviewData {
  return { prdTitle: "Auth System", issueCount: 3, ...overrides };
}

describe("DeletePreview", () => {
  it("names the PRD being deleted", () => {
    const { lastFrame } = render(<DeletePreview preview={preview()} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Auth System");
  });

  it("shows how many Issue files the delete will remove", () => {
    const { lastFrame } = render(<DeletePreview preview={preview({ issueCount: 5 })} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("5");
  });

  it("warns that the delete is permanent and unrecoverable", () => {
    // The strongest warning of the modal family: there is no git in the root to
    // restore from (ADR 0016), so the copy must make the irreversibility plain.
    const { lastFrame } = render(<DeletePreview preview={preview()} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/permanent|unrecoverable|cannot be undone|irreversible/);
  });

  it("closes every escape hatch a user might assume: no git, no archive, no undo", () => {
    // The grill rejected archive / trash / undo as out of scope — the confirm + the
    // done-gate are the only safety net. So the modal's copy must say so plainly:
    // no git to restore from, no archive/trash to recover from, no undo.
    const { lastFrame } = render(<DeletePreview preview={preview()} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/no git|not a git/);
    expect(frame).toContain("archive");
    expect(frame).toContain("undo");
  });

  it("shows the confirm/cancel hint", () => {
    const { lastFrame } = render(<DeletePreview preview={preview()} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Esc");
  });

  it("shows the confirm affordance (Enter / y to delete)", () => {
    const { lastFrame } = render(<DeletePreview preview={preview()} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/enter/);
    expect(frame).toMatch(/\by\b/);
  });
});
