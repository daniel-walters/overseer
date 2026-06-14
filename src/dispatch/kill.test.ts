import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStop, createKiller, realStop } from "./kill.js";
import type { StopResult } from "./kill.js";

describe("classifyStop", () => {
  const HANDLE = "17f1797e";

  it("maps a clean exit 0 to stopped", () => {
    expect(classifyStop({ exitCode: 0, stderr: "" }, HANDLE)).toBe("stopped");
  });

  it("maps a non-zero 'No job matching <handle>' to not-running", () => {
    // The agent had already finished or died — the stale-`live` case K does not
    // re-query for (ADR 0010).
    const stderr =
      "No job matching '17f1797e'. Run 'claude agents' to list running sessions.";
    expect(classifyStop({ exitCode: 1, stderr }, HANDLE)).toBe("not-running");
  });

  it("maps any other non-zero exit to uncertain", () => {
    // `couldn't confirm … may be restarting` exits non-zero too, but it is NOT
    // "wasn't running" — collapsing it into not-running would be a false
    // negative, so every non-`No job matching` failure reads uncertain.
    const stderr =
      "couldn't confirm 17f1797e was stopped — the background service may be restarting. Try again in a moment.";
    expect(classifyStop({ exitCode: 1, stderr }, HANDLE)).toBe("uncertain");
  });

  it("stays uncertain when 'No job matching' names a DIFFERENT handle", () => {
    // A stale line about another agent bleeding into stderr must not collapse a
    // genuinely-uncertain stop of OUR handle into a false "nothing to stop" — the
    // match is anchored to the handle we asked to stop.
    const stderr = "No job matching 'deadbeef'. Run 'claude agents'.";
    expect(classifyStop({ exitCode: 1, stderr }, HANDLE)).toBe("uncertain");
  });

  it("treats a spawn failure as unavailable", () => {
    // `claude` not on PATH (ENOENT) is a config error, not a transient retry, so
    // it gets its own verdict the human can act on.
    expect(
      classifyStop({ exitCode: 1, stderr: "", spawnFailed: true }, HANDLE),
    ).toBe("unavailable");
  });

  it("honours an exit-0 buffer-overflow as stopped, not uncertain", () => {
    // maxBuffer overflow throws even when the child exited cleanly; the stop still
    // landed, so an exit code of 0 surfaced through the error reads stopped.
    expect(classifyStop({ exitCode: 0, stderr: "" }, HANDLE)).toBe("stopped");
  });
});

describe("createKiller (against a writable temp root)", () => {
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

  /** A StopSeam fake recording the handle it was asked to stop. */
  function fakeStop(result: StopResult) {
    const calls: string[] = [];
    return {
      calls,
      stop: (handle: string): StopResult => {
        calls.push(handle);
        return result;
      },
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "overseer-kill-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("freezes the recorded handle for the selected live Issue", () => {
    const path = seedIssue("auth", "001-login.md", "in-progress");
    const handles = { [path]: "17f1797e" };
    const killer = createKiller(root, () => handles, () => ({ exitCode: 0, stderr: "" }));

    const preview = killer.readKill("auth", "001-login.md");
    if (!preview) throw new Error("expected a preview");
    expect(preview.handle).toBe("17f1797e");
    expect(preview.issueId).toBe("001-login.md");
  });

  it("stops the frozen handle on confirm and reports the classified outcome", () => {
    const path = seedIssue("auth", "001-login.md", "in-progress");
    const handles = { [path]: "17f1797e" };
    const stop = fakeStop({ exitCode: 0, stderr: "" });
    const killer = createKiller(root, () => handles, stop.stop);

    const preview = killer.readKill("auth", "001-login.md");
    if (!preview) throw new Error("expected a preview");
    expect(killer.kill(preview)).toBe("stopped");
    expect(stop.calls).toEqual(["17f1797e"]); // fired the frozen handle, nothing else
  });

  it("surfaces a non-running outcome when the agent had already gone", () => {
    const path = seedIssue("auth", "001-login.md", "in-progress");
    const handles = { [path]: "17f1797e" };
    const stop = fakeStop({
      exitCode: 1,
      stderr: "No job matching '17f1797e'.",
    });
    const killer = createKiller(root, () => handles, stop.stop);

    const preview = killer.readKill("auth", "001-login.md");
    if (!preview) throw new Error("expected a preview");
    expect(killer.kill(preview)).toBe("not-running");
  });

  it("yields no preview for a live card with no recorded handle (verdict/sidecar race)", () => {
    seedIssue("auth", "001-login.md", "in-progress");
    // No handle recorded for this Issue — nothing to stop.
    const killer = createKiller(root, () => ({}), () => ({ exitCode: 0, stderr: "" }));

    expect(killer.readKill("auth", "001-login.md")).toBeUndefined();
  });

  it("yields no preview for an Issue that vanished from the watched root", () => {
    const handles = { "/gone/auth/001-login.md": "17f1797e" };
    const killer = createKiller(root, () => handles, () => ({ exitCode: 0, stderr: "" }));

    // Nothing was seeded — the Issue does not exist on disk.
    expect(killer.readKill("auth", "001-login.md")).toBeUndefined();
  });
});

describe("realStop (production claude-stop edge)", () => {
  it("flags a missing claude binary as spawnFailed → unavailable", () => {
    // Point PATH at an empty dir so `claude` can't be resolved — an ENOENT, the
    // "claude not installed / not on PATH" case. realStop must mark it spawnFailed
    // so classifyStop reads `unavailable`, not a misleading transient `uncertain`.
    const emptyDir = mkdtempSync(join(tmpdir(), "overseer-nopath-"));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const result = realStop("17f1797e");
      expect(result.spawnFailed).toBe(true);
      expect(classifyStop(result, "17f1797e")).toBe("unavailable");
    } finally {
      process.env.PATH = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
