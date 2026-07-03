import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { realJiraSeam } from "./jiraSeam.js";

/**
 * Integration test for {@link realJiraSeam} against a **real acli + live JIRA** —
 * the one place the acli subprocess boundary is validated end-to-end (the model is
 * `stackGitSeam.realgit.test.ts`), as the Issue's testing plan requires. The pure
 * resolver ({@link import("./jiraSeam.js").resolveProjectKey} etc.) and the
 * reconciler are unit-tested with fakes; this proves the production seam actually
 * drives acli's create → transition → search round-trip against JIRA — including
 * the feature-card shape's `--type Story` and `--type Sub-task --parent` argument
 * shapes (ADR 0032), which only a live acli can validate.
 *
 * **Gated, and skipped by default.** It creates a real Story (and Sub-task), so it
 * never runs in ordinary CI or the unit loop. It runs only when both hold:
 *
 * - `acli` is on the PATH and authenticated, and
 * - `OVERSEER_JIRA_TEST_BOARD` names a JIRA board id safe to write throwaway
 *   Stories into (its resolved project is where the Story lands, and its Story
 *   workflow must offer an "In Progress" transition).
 *
 * Set the env var against a scratch board to exercise it locally:
 *   `OVERSEER_JIRA_TEST_BOARD=34 pnpm test jiraSeam.realacli`
 *
 * **Self-cleaning.** Every work item it creates is tracked and deleted in `afterAll`
 * (`acli jira workitem delete`), so repeated runs never accumulate orphan tickets —
 * the JIRA analogue of the prior art's `rmSync(repo)` teardown. The seam under
 * test owns only create/transition/read; the search verification and the cleanup
 * shell out to acli directly (the `acli()` helper below), exactly as the git prior
 * art reads and tears down its repo with a direct `git()` helper rather than
 * through the seam.
 */

const testBoard = process.env.OVERSEER_JIRA_TEST_BOARD;

/** Run one acli invocation directly and return its stdout — the test's own tool handle. */
function acli(...args: string[]): string {
  return execFileSync("acli", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Whether acli is installed and authenticated (so the round-trip can run). */
function acliAuthed(): boolean {
  try {
    acli("jira", "auth", "status");
    return true;
  } catch {
    return false;
  }
}

/**
 * The keys this run created (Story and Sub-task), deleted in `afterAll` so a failed
 * assertion — which aborts the test body before any inline cleanup — still leaves
 * JIRA clean.
 */
const createdKeys: string[] = [];

/**
 * JQL-search for a single key **through the seam under test** and return the
 * matched item, or undefined if not found yet. This drives the very
 * {@link realJiraSeam.searchStatuses} the reconciler uses to seed its cache, so the
 * round-trip validates the production seam method end-to-end (not a private
 * re-implementation of search).
 */
async function searchByKey(key: string) {
  const found = await realJiraSeam.searchStatuses([key]);
  return found.find((i) => i.key === key);
}

/**
 * Poll `fn` until it returns a defined value or the deadline passes. JIRA's search
 * index is eventually consistent, so a just-created/just-transitioned item can lag
 * the write by a second or two — long enough that `acli jira workitem search` on a
 * `key in (<key>)` JQL clause for a not-yet-indexed key exits non-zero ("issue does
 * not exist"), not just returns an empty result. `fn` (which shells out via
 * {@link searchByKey}) is awaited inside the loop's own try/catch, not the
 * caller's, so that lag is a retry, not an aborted test.
 */
async function poll<T>(
  fn: () => Promise<T | undefined>,
  { timeoutMs = 20000, intervalMs = 2000 } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = await fn();
    } catch {
      value = undefined;
    }
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const enabled = testBoard !== undefined && acliAuthed();

describe.skipIf(!enabled)("realJiraSeam against a live JIRA (gated)", () => {
  afterAll(() => {
    // Self-cleaning: bin every work item this run created so the test project stays
    // free of orphaned tickets across repeated runs. Best-effort — a cleanup
    // failure must not fail the run (the assertions already ran).
    if (createdKeys.length === 0) return;
    try {
      acli("jira", "workitem", "delete", "--key", createdKeys.join(","), "--yes");
    } catch {
      // Nothing more to do; a leftover ticket is a manual tidy, not a test failure.
    }
  });

  it("creates a Story with a parented Sub-task, transitions and finds both via JQL, then cleans up", async () => {
    const board = testBoard!;

    // Board → project location, through the seam.
    const project = await realJiraSeam.resolveProject(board);
    expect(project).toMatch(/^[A-Z][A-Z0-9]+$/);

    // Create the feature-card **Story** in that project, through the seam
    // (`--type Story`, ADR 0032). Track its key first thing so afterAll deletes it
    // even if a later assertion throws.
    const key = await realJiraSeam.createStory({
      project,
      summary: `Overseer mirror integration test ${new Date().toISOString()}`,
      description: "Created by the gated realJiraSeam integration test.",
    });
    createdKeys.push(key);
    expect(key).toMatch(/^[A-Z][A-Z0-9]+-\d+/);

    // Drive it to In Progress, through the seam.
    await realJiraSeam.transition(key, "In Progress");

    // Round-trip: find the Story via a real JQL search and confirm the search
    // reflects both its identity and the transition we just drove.
    const found = await poll(async () => {
      const item = await searchByKey(key);
      return item?.status === "In Progress" ? item : undefined;
    });
    expect(found?.key).toBe(key);
    expect(found?.status).toBe("In Progress");

    // Create a native **Sub-task** nested under the Story (`--type Sub-task
    // --parent <story>`, ADR 0032) and drive the same round-trip the reconciler
    // runs per Issue — a live acli would reject the type/parent shape if it were
    // wrong, so a successful create validates it end-to-end. Track its key first
    // thing so afterAll bins it too, even if a later assertion throws.
    const subtask = await realJiraSeam.createChildIssue({
      project,
      parent: key,
      summary: `Overseer sub-task integration test ${new Date().toISOString()}`,
      description: "Created by the gated realJiraSeam integration test.",
    });
    createdKeys.push(subtask);
    expect(subtask).toMatch(/^[A-Z][A-Z0-9]+-\d+/);

    // Drive the Sub-task to In Progress and confirm a real JQL search reflects both
    // its identity and the transition — same search path as the Story above.
    await realJiraSeam.transition(subtask, "In Progress");
    const foundSubtask = await poll(async () => {
      const item = await searchByKey(subtask);
      return item?.status === "In Progress" ? item : undefined;
    });
    expect(foundSubtask?.key).toBe(subtask);
    expect(foundSubtask?.status).toBe("In Progress");
  }, 60000);
});
