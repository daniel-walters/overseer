import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpawnEdge, type ExecSeam } from "./spawn.js";

/**
 * The spawn edge is tested through an injected exec seam (no real Claude) and a
 * real temp log directory (the durable failure log is fs, and asserting the
 * appended line is the point). Mirrors gitSetup's FakeGit / watcher's seam.
 */
describe("createSpawnEdge", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-spawn-"));
    logPath = join(dir, "state", "dispatch.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("spawn", () => {
    it("invokes claude --bg --permission-mode auto -p <prompt> with cwd=repo", () => {
      const exec = vi.fn<ExecSeam>();
      const { spawn } = createSpawnEdge({ exec, logPath });

      spawn("/repos/api", "do the thing");

      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        "claude",
        ["--bg", "--permission-mode", "auto", "-p", "do the thing"],
        { cwd: "/repos/api" },
      );
    });

    it("propagates a launch failure so the caller can roll back and log", () => {
      const exec = vi.fn<ExecSeam>(() => {
        throw new Error("claude: command not found");
      });
      const { spawn } = createSpawnEdge({ exec, logPath });

      expect(() => spawn("/repos/api", "prompt")).toThrow(
        "claude: command not found",
      );
    });
  });

  describe("logFailure", () => {
    it("appends a timestamped record (edge, issue, repo, error) to the log", () => {
      const { logFailure } = createSpawnEdge({ exec: vi.fn(), logPath });

      logFailure({ issueId: "001-a.md", repo: "/repos/api", error: "boom", edge: "reviewer" });

      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain("001-a.md");
      expect(contents).toContain("/repos/api");
      expect(contents).toContain("boom");
      // The edge discriminator distinguishes implementor vs reviewer failures.
      expect(contents).toContain("reviewer");
      // ISO-8601 timestamp prefix.
      expect(contents).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("creates the log's parent directory if it does not exist", () => {
      expect(existsSync(join(dir, "state"))).toBe(false);
      const { logFailure } = createSpawnEdge({ exec: vi.fn(), logPath });

      logFailure({ issueId: "001-a.md", repo: "/repos/api", error: "boom", edge: "implementor" });

      expect(existsSync(logPath)).toBe(true);
    });

    it("appends rather than overwrites across multiple failures", () => {
      const { logFailure } = createSpawnEdge({ exec: vi.fn(), logPath });

      logFailure({ issueId: "001-a.md", repo: "/repos/api", error: "first", edge: "implementor" });
      logFailure({ issueId: "002-b.md", repo: "/repos/web", error: "second", edge: "reviewer" });

      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("001-a.md");
      expect(lines[1]).toContain("002-b.md");
    });
  });
});
