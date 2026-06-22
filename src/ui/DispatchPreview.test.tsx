import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DispatchPreview } from "./DispatchPreview.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { DispatchIssue } from "../dispatch/reader.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function issue(id: string): DispatchIssue {
  return { id, title: id, path: `/root/prd/${id}`, status: "ready-for-agent", blockedBy: [], repo: "/r", worktree: undefined, branch: undefined, deviation: undefined, reviewVerdict: undefined, slice: undefined, body: "" };
}

function entry(
  classification: FrontierEntry["classification"],
  id: string,
  reason?: string,
): FrontierEntry {
  return { issue: issue(id), classification, reason };
}

const frontier: readonly FrontierEntry[] = [
  entry("spawn", "001-spawnable.md"),
  entry("queued", "002-queued.md", "waiting on blocker(s) not yet done: 001"),
  entry("skipped", "003-human.md", 'status is "ready-for-human"'),
  entry("blocked", "004-dangling.md", "blocked_by references missing Issue(s): 999-ghost.md"),
];

describe("DispatchPreview", () => {
  it("lists the Issues that will spawn", () => {
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={frontier} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("001-spawnable.md");
  });

  it("lists queued Issues with their reason", () => {
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={frontier} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("002-queued.md");
    expect(frame).toContain("waiting on blocker");
  });

  it("lists skipped and blocked Issues with their reasons", () => {
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={frontier} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("003-human.md");
    expect(frame).toContain("ready-for-human");
    expect(frame).toContain("004-dangling.md");
    expect(frame).toContain("999-ghost.md");
  });

  it("names the PRD being dispatched", () => {
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={frontier} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Auth");
  });

  it("shows the confirm/cancel keys", () => {
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={frontier} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/enter|y/);
    expect(frame).toMatch(/esc/);
  });

  it("tells the user clearly when nothing is eligible to spawn", () => {
    const empty: readonly FrontierEntry[] = [
      entry("skipped", "001-a.md", 'status is "backlog"'),
    ];
    const { lastFrame } = render(<DispatchPreview prdTitle="Auth" frontier={empty} />);
    const frame = stripAnsi(lastFrame() ?? "").toLowerCase();
    expect(frame).toMatch(/nothing|no .*spawn|empty/);
  });
});
