import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOutputReader, logsFailureMessage } from "./agentOutputReader.js";

describe("createAgentOutputReader (against a writable temp root)", () => {
  let root: string;

  /** Write one Issue file with the given status into a PRD dir under root. */
  function seedIssue(prdId: string, fileName: string, status: string): string {
    const prdDir = join(root, prdId);
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, "prd.md"), "---\ntitle: A PRD\n---\nbody\n");
    const path = join(prdDir, fileName);
    writeFileSync(
      path,
      `---\ntitle: An Issue\nstatus: ${status}\nrepo: /repos/api\n---\nbody\n`,
    );
    return path;
  }

  /** A LogsSeam fake recording the handle it was asked to read. */
  function fakeLogs(stdout: string) {
    const calls: string[] = [];
    return {
      calls,
      logs: (handle: string): string => {
        calls.push(handle);
        return stdout;
      },
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-agentout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the recorded handle's claude-logs output for the selected Issue", () => {
    const path = seedIssue("auth", "001-login.md", "in-progress");
    const handles = { [path]: "17f1797e" };
    const logs = fakeLogs("running tests…\nall green\n");
    const reader = createAgentOutputReader(root, () => handles, logs.logs);

    const result = reader.readAgentOutput("auth", "001-login.md");
    if (!result) throw new Error("expected output");
    expect(result.title).toBe("An Issue");
    expect(result.output).toBe("running tests…\nall green\n");
    expect(logs.calls).toEqual(["17f1797e"]); // read the frozen handle, nothing else
  });

  it("returns Claude's 'No job matching' stdout verbatim (not suppressed)", () => {
    // The agent just exited between the last scan and the keypress; `claude logs`
    // exits 0 with this message on stdout. It is informative (it tells the user the
    // agent is gone and should be recovered with R) and, at exit 0, indistinguishable
    // from real output — so it is shown in the modal, never swallowed.
    const path = seedIssue("auth", "001-login.md", "in-progress");
    const handles = { [path]: "17f1797e" };
    const noJob = "No job matching '17f1797e'. Run 'claude agents' to list sessions.";
    const reader = createAgentOutputReader(root, () => handles, () => noJob);

    const result = reader.readAgentOutput("auth", "001-login.md");
    expect(result?.output).toBe(noJob);
  });

  it("returns undefined for a live card with no recorded handle (verdict/sidecar race)", () => {
    seedIssue("auth", "001-login.md", "in-progress");
    // No handle recorded for this Issue — the sidecar miss the App turns into a notice.
    const logs = fakeLogs("unused");
    const reader = createAgentOutputReader(root, () => ({}), logs.logs);

    expect(reader.readAgentOutput("auth", "001-login.md")).toBeUndefined();
    expect(logs.calls).toEqual([]); // never shelled out — there was nothing to read
  });

  it("returns undefined (no throw) for an Issue that vanished from the watched root", () => {
    const handles = { "/gone/auth/001-login.md": "17f1797e" };
    const reader = createAgentOutputReader(root, () => handles, () => "x");

    // Nothing was seeded — the Issue does not exist on disk.
    expect(reader.readAgentOutput("auth", "001-login.md")).toBeUndefined();
  });
});

describe("logsFailureMessage (the failed-read placeholders)", () => {
  // A failed refresh replaces the screen with these placeholders, so — like the
  // modal hint and the refresh gesture — they must instruct pressing `r` to retry,
  // never the old "close and press o again" (Issue 002).
  it("instructs pressing r (never o) on every failure mode", () => {
    for (const code of ["ETIMEDOUT", "ENOBUFS", undefined]) {
      const msg = logsFailureMessage(code);
      expect(msg).toMatch(/\br\b/); // references the r keypress
      expect(msg.toLowerCase()).toContain("press r");
      expect(msg.toLowerCase()).not.toContain("press o");
      expect(msg.toLowerCase()).not.toContain("o again");
    }
  });

  it("distinguishes timeout, overflow, and unavailable", () => {
    expect(logsFailureMessage("ETIMEDOUT")).toMatch(/timed out/i);
    expect(logsFailureMessage("ENOBUFS")).toMatch(/too large/i);
    expect(logsFailureMessage(undefined)).toMatch(/unavailable/i);
  });
});
