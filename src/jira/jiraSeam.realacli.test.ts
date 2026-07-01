import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { realJiraSeam } from "./jiraSeam.js";

/**
 * Integration test for {@link realJiraSeam} against a **real acli + live JIRA** —
 * the one place the acli subprocess boundary is validated end-to-end (the model is
 * `stackGitSeam.realgit.test.ts`), as the Issue's testing plan requires. The pure
 * parsers ({@link import("./jiraSeam.js").parseBoardProject} etc.) and the
 * reconciler are unit-tested with fakes; this proves the production seam actually
 * drives acli's create → transition → read round-trip.
 *
 * **Gated, and skipped by default.** It creates a real epic, so it never runs in
 * ordinary CI or the unit loop. It runs only when both hold:
 *
 * - `acli` is on the PATH and authenticated, and
 * - `OVERSEER_JIRA_TEST_BOARD` names a JIRA board id safe to write throwaway epics
 *   into (its resolved project is where the epic lands).
 *
 * Set the env var against a scratch board to exercise it locally:
 *   `OVERSEER_JIRA_TEST_BOARD=34 pnpm test jiraSeam.realacli`
 */

const testBoard = process.env.OVERSEER_JIRA_TEST_BOARD;

/** Whether acli is installed and authenticated (so the round-trip can run). */
function acliAuthed(): boolean {
  try {
    execFileSync("acli", ["jira", "auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

const enabled = testBoard !== undefined && acliAuthed();

describe.skipIf(!enabled)("realJiraSeam against a live JIRA (gated)", () => {
  it("resolves a board's project, then creates → transitions → reads an epic", async () => {
    const board = testBoard!;

    // Board → project location.
    const project = await realJiraSeam.resolveProject(board);
    expect(project).toMatch(/^[A-Z][A-Z0-9]+$/);

    // Create an epic in that project.
    const key = await realJiraSeam.createEpic({
      project,
      summary: `Overseer mirror smoke test ${new Date().toISOString()}`,
      description: "Created by the gated realJiraSeam integration test.",
    });
    expect(key).toMatch(/^[A-Z][A-Z0-9]+-\d+/);

    // Read its current status back.
    const status = await realJiraSeam.currentStatus(key);
    expect(typeof status).toBe("string");

    // Drive it to In Progress and confirm the read reflects the move.
    await realJiraSeam.transition(key, "In Progress");
    expect(await realJiraSeam.currentStatus(key)).toBe("In Progress");
  }, 60000);
});
