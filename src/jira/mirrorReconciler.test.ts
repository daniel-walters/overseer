import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  createMirrorReconciler,
  type MirrorFileState,
  type IssueMirrorState,
} from "./mirrorReconciler.js";
import type {
  CreateChildInput,
  CreateEpicInput,
  JiraSeam,
} from "./jiraSeam.js";
import type { JiraOptIn } from "../issueFile.js";
import type { Board, Issue, Lane, PRD } from "../model.js";

const ROOT = "/root";

/**
 * A scriptable stand-in for the acli-backed {@link JiraSeam}, mirroring
 * `mergeSeam.test.ts`'s `FakeMergeGit`: it answers from in-memory state and
 * records every call (and its order) so the reconciler is asserted through the
 * seam boundary — the delta set and the calls made — not its private internals.
 */
class FakeJiraSeam implements JiraSeam {
  /** board id → project key, seeding {@link resolveProject}. */
  readonly projectByBoard = new Map<string, string>();
  /** key → current status name; every created/seeded epic *and* child lives here. */
  readonly statusByKey = new Map<string, string>();
  /** Target status names the workflow can legally transition to; others throw. */
  readonly legalStatuses = new Set<string>();
  /** The status a freshly-created epic or child lands in. */
  initialStatus = "To Do";
  /** When set, `createEpic` throws — a simulated acli failure. */
  failCreate = false;
  /** When set, `createChildIssue` throws — a child-create failure isolated from the epic. */
  failChildCreate = false;
  /** When set, `currentStatus` throws for this key — a simulated transient read failure. */
  failCurrentStatusFor: string | undefined = undefined;
  /** board id → its live active sprint id, seeding {@link resolveActiveSprint}. */
  readonly activeSprintByBoard = new Map<string, string>();
  /** When set, `resolveActiveSprint` throws — a simulated acli/agile failure. */
  failResolveActiveSprint = false;
  /** When set, `assignToSprint` throws — a simulated placement failure (acli gap). */
  failAssignToSprint = false;
  /** child key → the sprint it was placed into, for placement assertions. */
  readonly sprintByKey = new Map<string, string>();
  /** Ordered record of every seam call. */
  readonly calls: string[] = [];
  /** The inputs `createEpic` was called with, for summary/project assertions. */
  readonly created: CreateEpicInput[] = [];
  /** The inputs `createChildIssue` was called with, for parent/summary/description assertions. */
  readonly childrenCreated: CreateChildInput[] = [];
  private seq = 0;
  private childSeq = 0;

  async resolveProject(board: string): Promise<string> {
    this.calls.push(`resolveProject:${board}`);
    const project = this.projectByBoard.get(board);
    if (project === undefined) throw new Error(`no project for board ${board}`);
    return project;
  }

  async createEpic(input: CreateEpicInput): Promise<string> {
    this.calls.push(`createEpic:${input.project}`);
    if (this.failCreate) throw new Error("acli create failed");
    this.created.push(input);
    const key = `${input.project}-${++this.seq}`;
    this.statusByKey.set(key, this.initialStatus);
    return key;
  }

  async createChildIssue(input: CreateChildInput): Promise<string> {
    // Record the parent so epic-before-child ordering is assertable via `calls`.
    this.calls.push(`createChild:${input.parent}`);
    if (this.failChildCreate) throw new Error("acli child create failed");
    this.childrenCreated.push(input);
    // A distinct key range from epics (100+) so a child never collides with an
    // epic key in `statusByKey` and assertions read unambiguously.
    const key = `${input.project}-${100 + ++this.childSeq}`;
    this.statusByKey.set(key, this.initialStatus);
    return key;
  }

  async currentStatus(key: string): Promise<string | undefined> {
    this.calls.push(`currentStatus:${key}`);
    if (key === this.failCurrentStatusFor) {
      throw new Error("acli read failed");
    }
    return this.statusByKey.get(key);
  }

  async transition(key: string, toStatus: string): Promise<void> {
    this.calls.push(`transition:${key}->${toStatus}`);
    if (!this.legalStatuses.has(toStatus)) {
      throw new Error(`illegal transition to ${toStatus}`);
    }
    this.statusByKey.set(key, toStatus);
  }

  async resolveActiveSprint(board: string): Promise<string | undefined> {
    this.calls.push(`resolveActiveSprint:${board}`);
    if (this.failResolveActiveSprint) throw new Error("acli sprint read failed");
    // Absent ⇒ the board has no active sprint (a logged no-op upstream).
    return this.activeSprintByBoard.get(board);
  }

  async assignToSprint(sprintId: string, key: string): Promise<void> {
    this.calls.push(`assignToSprint:${sprintId}->${key}`);
    if (this.failAssignToSprint) throw new Error("acli sprint assign failed");
    this.sprintByKey.set(key, sprintId);
  }
}

/**
 * A minimal board Issue; the mirror reads `id` (the filename join key) and
 * `title` off it, and reads the raw authored status + body + backref from the
 * Issue file (seeded via {@link harness}'s `setIssue`), never from the model lane.
 */
function issue(id: string, lane: Lane = "backlog", title = id): Issue {
  return { id, title, lane };
}

/** A PRD; `issues` defaults empty for the epic-only tests that predate children. */
function prd(
  id: string,
  lane: PRD["lane"],
  title = id,
  issues: Issue[] = [],
): PRD {
  return { id, title, lane, issues };
}

function board(...prds: PRD[]): Board {
  return { prds };
}

/**
 * Build a reconciler over an in-memory file store, returning the reconciler plus
 * handles to inspect/seed the store (the prd.md opt-in + epic backref, the Issue
 * files' status/body/child-backref) and the captured log lines.
 */
function harness(seam: FakeJiraSeam, defaultBoard?: string) {
  const files = new Map<string, MirrorFileState>();
  const issueFiles = new Map<string, IssueMirrorState>();
  const logs: string[] = [];
  const set = (id: string, state: MirrorFileState) =>
    files.set(join(ROOT, id), state);
  const setIssue = (prdId: string, issueId: string, state: IssueMirrorState) =>
    issueFiles.set(join(ROOT, prdId, issueId), state);
  const reconciler = createMirrorReconciler({
    root: ROOT,
    seam,
    defaultBoard,
    readMirror: (prdDir) => files.get(prdDir) ?? {},
    writeEpic: (prdDir, key) => {
      const prev = files.get(prdDir) ?? {};
      files.set(prdDir, { ...prev, epicKey: key });
    },
    readIssueMirror: (issuePath) => issueFiles.get(issuePath) ?? {},
    writeIssueKey: (issuePath, key) => {
      const prev = issueFiles.get(issuePath) ?? {};
      issueFiles.set(issuePath, { ...prev, childKey: key });
    },
    log: (m) => logs.push(m),
  });
  const epicKeyOf = (id: string) => files.get(join(ROOT, id))?.epicKey;
  const childKeyOf = (prdId: string, issueId: string) =>
    issueFiles.get(join(ROOT, prdId, issueId))?.childKey;
  return { reconciler, set, setIssue, logs, epicKeyOf, childKeyOf };
}

const optIn = (over: Partial<JiraOptIn> = {}): JiraOptIn => ({ ...over });

describe("mirrorReconciler — epic create", () => {
  it("creates one epic for an opted-in PRD with no backref and writes the key back", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, epicKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });

    const delta = await reconciler.reconcile(board(prd("auth", "backlog", "Auth")));

    expect(seam.created).toEqual([{ project: "DS", summary: "Auth" }]);
    expect(delta.created).toEqual([{ prd: "auth", key: "DS-1" }]);
    // The created key is written back onto prd.md as the backref.
    expect(epicKeyOf("auth")).toBe("DS-1");
  });

  it("does nothing for a PRD with no jira block", async () => {
    const seam = new FakeJiraSeam();
    const { reconciler } = harness(seam);
    // No opt-in seeded for "private" ⇒ readMirror returns {}.

    const delta = await reconciler.reconcile(board(prd("private", "in-progress")));

    expect(seam.calls).toEqual([]);
    expect(delta).toEqual({ created: [], transitioned: [], childrenCreated: [], childrenTransitioned: [], placed: [] });
  });

  it("never creates a second epic when the backref is already present", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do");
    const { reconciler, set, epicKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "backlog")));

    expect(seam.created).toEqual([]);
    expect(delta.created).toEqual([]);
    // The existing backref is untouched.
    expect(epicKeyOf("auth")).toBe("DS-9");
    // No board→project lookup either — a linked PRD needs no board resolution.
    expect(seam.calls).not.toContain("resolveProject:34");
  });

  it("derives the project from the board, or honours an explicit project override", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set } = harness(seam);
    set("byBoard", { optIn: optIn({ board: "34" }) });
    set("byOverride", { optIn: optIn({ board: "34", project: "OVR" }) });

    await reconciler.reconcile(board(prd("byBoard", "backlog"), prd("byOverride", "backlog")));

    // Board-derived: resolveProject called, epic created in DS.
    expect(seam.calls).toContain("resolveProject:34");
    // Override: project used directly, resolveProject NOT called for it.
    expect(seam.created.map((c) => c.project)).toEqual(["DS", "OVR"]);
    // resolveProject fires exactly once (only for the non-override PRD).
    expect(seam.calls.filter((c) => c === "resolveProject:34")).toHaveLength(1);
  });

  it("falls back to the configured default_board when the opt-in names none", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("99", "DEF");
    const { reconciler, set } = harness(seam, "99");
    set("auth", { optIn: optIn() }); // empty block ⇒ defer to default_board

    await reconciler.reconcile(board(prd("auth", "backlog")));

    expect(seam.calls).toContain("resolveProject:99");
    expect(seam.created.map((c) => c.project)).toEqual(["DEF"]);
  });

  it("logs a no-op and creates nothing when no board can be resolved", async () => {
    const seam = new FakeJiraSeam();
    const { reconciler, set, logs } = harness(seam);
    set("auth", { optIn: optIn() }); // no board, no default_board

    const delta = await reconciler.reconcile(board(prd("auth", "backlog")));

    expect(seam.created).toEqual([]);
    expect(delta.created).toEqual([]);
    expect(logs.join("\n")).toMatch(/no board/i);
  });

  it("isolates a seam failure to its own PRD, still reconciling the rest", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.failCreate = true; // every create throws
    const { reconciler, set, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });

    const delta = await reconciler.reconcile(board(prd("auth", "backlog")));

    // The failure is swallowed as a logged no-op — reconcile returns normally.
    expect(delta.created).toEqual([]);
    expect(logs.join("\n")).toMatch(/failed/i);
  });

  it("distinguishes a create that succeeded but whose backref write failed", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const logs: string[] = [];
    // A writeEpic that throws, to simulate the backref write failing right
    // after a successful JIRA create.
    const failingReconciler = createMirrorReconciler({
      root: ROOT,
      seam,
      readMirror: (prdDir) =>
        prdDir === join(ROOT, "auth") ? { optIn: optIn({ board: "34" }) } : {},
      writeEpic: () => {
        throw new Error("disk full");
      },
      readIssueMirror: () => ({}),
      writeIssueKey: () => {},
      log: (m) => logs.push(m),
    });

    const delta = await failingReconciler.reconcile(board(prd("auth", "backlog")));

    // The epic was created against JIRA, but never recorded in the delta or
    // the backref, since the write that would have made it idempotent failed.
    expect(seam.created).toEqual([{ project: "DS", summary: "auth" }]);
    expect(delta.created).toEqual([]);
    // The failure is distinguished from the generic no-op: it names the
    // duplicate-epic risk so an operator can add the backref by hand.
    expect(logs.join("\n")).toMatch(/duplicate epic/i);
  });
});

describe("mirrorReconciler — re-entrancy", () => {
  it("no-ops a reconcile that arrives while one is already in flight, so it can't create a duplicate epic", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    // Block resolveProject until the second call is already in-flight, so the
    // first pass's createEpic hasn't run (and the backref hasn't been written)
    // by the time the second reconcile() call is made — the race the guard closes.
    let releaseFirstCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const originalResolveProject = seam.resolveProject.bind(seam);
    seam.resolveProject = async (board: string) => {
      await gate;
      return originalResolveProject(board);
    };
    const { reconciler, set, epicKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });

    const first = reconciler.reconcile(board(prd("auth", "backlog", "Auth")));
    const second = reconciler.reconcile(board(prd("auth", "backlog", "Auth")));
    releaseFirstCall();
    const [firstDelta, secondDelta] = await Promise.all([first, second]);

    // Only the in-flight pass creates the epic; the overlapping call is a no-op.
    expect(seam.created).toEqual([{ project: "DS", summary: "Auth" }]);
    expect(firstDelta.created).toEqual([{ prd: "auth", key: "DS-1" }]);
    expect(secondDelta).toEqual({ created: [], transitioned: [], childrenCreated: [], childrenTransitioned: [], placed: [] });
    expect(epicKeyOf("auth")).toBe("DS-1");
  });
});

describe("mirrorReconciler — epic status self-heal", () => {
  it("transitions a freshly-created epic to match a PRD already in progress", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.legalStatuses.add("In Progress");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });

    const delta = await reconciler.reconcile(board(prd("auth", "in-progress")));

    // Created in To Do, then driven to In Progress to match the lane.
    expect(delta.transitioned).toEqual([{ key: "DS-1", to: "In Progress" }]);
    expect(seam.statusByKey.get("DS-1")).toBe("In Progress");
  });

  it("leaves a backlog PRD's fresh epic in To Do (no needless transition)", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.legalStatuses.add("In Progress"); // available, but must not be used
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });

    const delta = await reconciler.reconcile(board(prd("auth", "backlog")));

    expect(delta.transitioned).toEqual([]);
    expect(seam.calls).not.toContain("transition:DS-1->To Do");
  });

  it("self-heals a linked epic toward the board when a human moved it", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do"); // someone dragged it back
    seam.legalStatuses.add("Done");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "done")));

    expect(delta.transitioned).toEqual([{ key: "DS-9", to: "Done" }]);
    expect(seam.statusByKey.get("DS-9")).toBe("Done");
  });

  it("does not transition an epic already at its target status", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "In Progress");
    seam.legalStatuses.add("In Progress");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "in-progress")));

    expect(delta.transitioned).toEqual([]);
    expect(seam.calls).not.toContain("transition:DS-9->In Progress");
  });

  it("degrades an unavailable target status to a logged no-op, never a throw", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do");
    // "Done" is NOT a legal transition here ⇒ seam.transition throws.
    const { reconciler, set, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "done")));

    // Attempted, but the workflow lacks the status: no crash, no delta, logged.
    expect(delta.transitioned).toEqual([]);
    expect(seam.statusByKey.get("DS-9")).toBe("To Do"); // unchanged
    expect(logs.join("\n")).toMatch(/no-op/i);
  });

  it("still reconciles a PRD's children when the epic's own self-heal read fails", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do"); // epic already at target
    seam.failCurrentStatusFor = "DS-9"; // the epic's own status read fails
    const { reconciler, set, setIssue, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The epic's self-heal read failure is its own logged no-op — it must not
    // escape to the outer per-PRD catch and silently drop the child that
    // reconciles independently just below it.
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(logs.join("\n")).toMatch(/epic DS-9.*could not be read/i);
  });

  it("terminates the backref write-back self-scan as a zero-JIRA no-op", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.legalStatuses.add("In Progress");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    const b = board(prd("auth", "in-progress"));

    // First pass creates + transitions (writing the backref).
    await reconciler.reconcile(b);
    const callsAfterFirst = seam.calls.length;

    // The write-back fires a re-scan → a second reconcile. With the backref now
    // present and the epic already at target, it makes NO new JIRA write.
    const second = await reconciler.reconcile(b);

    expect(second.created).toEqual([]);
    expect(second.transitioned).toEqual([]);
    // The only calls the second pass may add are reads (currentStatus), never
    // a create or a transition.
    expect(seam.calls.slice(callsAfterFirst).filter((c) => c.startsWith("createEpic")))
      .toEqual([]);
    expect(seam.calls.slice(callsAfterFirst).filter((c) => c.startsWith("transition")))
      .toEqual([]);
  });
});

describe("mirrorReconciler — child create", () => {
  it("creates a child under the epic for each Issue (incl. backlog), writing the key back and using the body prose as the description", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, setIssue, childKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001-login.md", {
      status: "backlog",
      body: "Build the login form.\n",
    });
    setIssue("auth", "002-token.md", {
      status: "backlog",
      body: "Issue session tokens.\n",
    });

    const delta = await reconciler.reconcile(
      board(
        prd("auth", "backlog", "Auth", [
          issue("001-login.md", "backlog", "Login form"),
          issue("002-token.md", "backlog", "Session tokens"),
        ]),
      ),
    );

    // A child per Issue — including a backlog one — parented to the fresh epic.
    // Summary is the Issue title; description is the body prose (no frontmatter).
    expect(seam.childrenCreated).toEqual([
      {
        project: "DS",
        parent: "DS-1",
        summary: "Login form",
        description: "Build the login form.\n",
      },
      {
        project: "DS",
        parent: "DS-1",
        summary: "Session tokens",
        description: "Issue session tokens.\n",
      },
    ]);
    expect(delta.childrenCreated).toEqual([
      { issue: "001-login.md", key: "DS-101" },
      { issue: "002-token.md", key: "DS-102" },
    ]);
    // The child key is written back onto each Issue file.
    expect(childKeyOf("auth", "001-login.md")).toBe("DS-101");
    expect(childKeyOf("auth", "002-token.md")).toBe("DS-102");
  });

  it("creates a summary-only child when the Issue has no body prose", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { status: "backlog" }); // no body

    await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // No `description` key at all — a body-less Issue never sends an empty string.
    expect(seam.childrenCreated).toEqual([
      { project: "DS", parent: "DS-1", summary: "One" },
    ]);
  });

  it("creates the epic before any child, parenting children to it (epic-before-child ordering)", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    const epicAt = seam.calls.indexOf("createEpic:DS");
    const childAt = seam.calls.indexOf("createChild:DS-1");
    expect(epicAt).toBeGreaterThanOrEqual(0);
    expect(childAt).toBeGreaterThan(epicAt);
    // The child is parented to the epic that was created first.
    expect(seam.childrenCreated[0]!.parent).toBe("DS-1");
  });

  it("never creates a child before its epic exists — a failed epic create suppresses all its children", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.failCreate = true; // the epic create throws
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // No epic ⇒ no child could be parented: not a single createChild call.
    expect(seam.childrenCreated).toEqual([]);
    expect(delta.childrenCreated).toEqual([]);
    expect(seam.calls.filter((c) => c.startsWith("createChild"))).toEqual([]);
  });

  it("creates no children for a PRD with no jira block, even when it has Issues", async () => {
    const seam = new FakeJiraSeam();
    const { reconciler } = harness(seam);

    const delta = await reconciler.reconcile(
      board(
        prd("private", "in-progress", "Private", [
          issue("001.md", "in-progress", "One"),
        ]),
      ),
    );

    expect(seam.calls).toEqual([]);
    expect(delta.childrenCreated).toEqual([]);
  });

  it("never re-creates a child when the jira_key backref is already present", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do"); // the linked epic
    seam.statusByKey.set("DS-50", "To Do"); // the linked child
    const { reconciler, set, setIssue, childKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    setIssue("auth", "001.md", { status: "backlog", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    expect(seam.childrenCreated).toEqual([]);
    expect(delta.childrenCreated).toEqual([]);
    expect(childKeyOf("auth", "001.md")).toBe("DS-50"); // untouched
  });

  it("survives a rename: a renumbered Issue file carrying the backref is neither orphaned nor duplicated", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do");
    seam.statusByKey.set("DS-50", "To Do");
    const { reconciler, set, setIssue, childKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    // The file was renumbered 001-login.md → 005-login.md; its jira_key travels
    // with the file content and is matched on the backref's presence, not the path.
    setIssue("auth", "005-login.md", { status: "backlog", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("005-login.md", "backlog")])),
    );

    expect(seam.childrenCreated).toEqual([]);
    expect(delta.childrenCreated).toEqual([]);
    expect(childKeyOf("auth", "005-login.md")).toBe("DS-50");
  });

  it("distinguishes a child create that succeeded but whose backref write failed", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const logs: string[] = [];
    const failingReconciler = createMirrorReconciler({
      root: ROOT,
      seam,
      readMirror: (prdDir) =>
        prdDir === join(ROOT, "auth") ? { optIn: optIn({ board: "34" }) } : {},
      writeEpic: () => {}, // the epic backref writes fine
      readIssueMirror: () => ({ status: "backlog" }),
      writeIssueKey: () => {
        throw new Error("disk full");
      },
      log: (m) => logs.push(m),
    });

    const delta = await failingReconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child was created against JIRA but never recorded (no idempotent backref).
    expect(seam.childrenCreated).toHaveLength(1);
    expect(delta.childrenCreated).toEqual([]);
    expect(logs.join("\n")).toMatch(/duplicate child/i);
  });

  it("keeps a child's create in the delta even when the post-create status read fails", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do"); // epic already at target
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, childKeyOf } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    // createChildIssue always mints the next DS-10x key; tell the fake to fail
    // the very next currentStatus read (the freshly-created child's).
    seam.failCurrentStatusFor = "DS-101";

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child was genuinely created and its backref durably written; a
    // transient read failure during self-heal must not erase that from the
    // delta (mirrors the epic path's create-before-self-heal-read ordering).
    expect(seam.childrenCreated).toHaveLength(1);
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(childKeyOf("auth", "001.md")).toBe("DS-101");
  });
});

describe("mirrorReconciler — sprint/backlog placement", () => {
  it("places a newly-created child into the board's active sprint when target is sprint", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child lands in the board's live active sprint — recorded in the delta
    // and driven through the seam.
    expect(delta.placed).toEqual([
      { issue: "001.md", key: "DS-101", sprint: "S1" },
    ]);
    expect(seam.sprintByKey.get("DS-101")).toBe("S1");
    expect(seam.calls).toContain("assignToSprint:S1->DS-101");
  });

  it("leaves a target: backlog child in the backlog — no sprint resolve, no assign", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1"); // available, but must not be used
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "backlog" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child is created, but never placed: backlog needs no action, so the
    // sprint is never even resolved (user story 19: no needless JIRA calls).
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(delta.placed).toEqual([]);
    expect(seam.calls.some((c) => c.startsWith("resolveActiveSprint"))).toBe(false);
    expect(seam.calls.some((c) => c.startsWith("assignToSprint"))).toBe(false);
  });

  it("defaults an omitted target to backlog (no placement)", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1");
    const { reconciler, set, setIssue } = harness(seam);
    // No `target` on the block ⇒ the reconciler defaults to backlog.
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    expect(delta.placed).toEqual([]);
    expect(seam.calls.some((c) => c.startsWith("assignToSprint"))).toBe(false);
  });

  it("places only at create — a later reconcile never re-places a linked child", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "To Do"); // linked epic
    seam.statusByKey.set("DS-50", "To Do"); // linked child, already created earlier
    seam.activeSprintByBoard.set("34", "S1");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }), epicKey: "DS-9" });
    setIssue("auth", "001.md", { status: "backlog", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child already exists (backref present), so placement — set once at
    // create — is never re-evaluated: the team owns sprint moves thereafter.
    expect(delta.placed).toEqual([]);
    expect(seam.calls.some((c) => c.startsWith("assignToSprint"))).toBe(false);
  });

  it("never sprints the epic — only children are placed", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The only assignment is the child's (DS-101); the epic (DS-1) is never
    // placed into a sprint.
    const assigns = seam.calls.filter((c) => c.startsWith("assignToSprint"));
    expect(assigns).toEqual(["assignToSprint:S1->DS-101"]);
    expect(seam.sprintByKey.has("DS-1")).toBe(false);
  });

  it("resolves the active sprint once per PRD, however many children it places", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }) });
    setIssue("auth", "001.md", { status: "backlog" });
    setIssue("auth", "002.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(
        prd("auth", "backlog", "Auth", [
          issue("001.md", "backlog", "One"),
          issue("002.md", "backlog", "Two"),
        ]),
      ),
    );

    // Both children land in the sprint, but the board's active sprint is read
    // just once for the whole PRD (memoized) — not once per child.
    expect(delta.placed).toEqual([
      { issue: "001.md", key: "DS-101", sprint: "S1" },
      { issue: "002.md", key: "DS-102", sprint: "S1" },
    ]);
    expect(seam.calls.filter((c) => c === "resolveActiveSprint:34")).toHaveLength(1);
  });

  it("degrades to a logged no-op when the board has no active sprint — child stays in backlog", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    // No active sprint seeded for board 34 ⇒ resolveActiveSprint returns undefined.
    const { reconciler, set, setIssue, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child is still created; it simply isn't placed — a logged no-op.
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(delta.placed).toEqual([]);
    expect(seam.calls.some((c) => c.startsWith("assignToSprint"))).toBe(false);
    expect(logs.join("\n")).toMatch(/no active sprint/i);
  });

  it("keeps a child's create when its sprint assignment fails — a logged no-op, never a throw", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    seam.activeSprintByBoard.set("34", "S1");
    seam.failAssignToSprint = true; // the assign throws (e.g. the acli sprint gap)
    const { reconciler, set, setIssue, childKeyOf, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34", target: "sprint" }) });
    setIssue("auth", "001.md", { status: "backlog" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child genuinely exists and its backref is written; a failed placement
    // must not erase that or crash the pass — it's just a logged no-op.
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(childKeyOf("auth", "001.md")).toBe("DS-101");
    expect(delta.placed).toEqual([]);
    expect(seam.sprintByKey.has("DS-101")).toBe(false);
    expect(logs.join("\n")).toMatch(/could not be placed/i);
  });
});

describe("mirrorReconciler — child status self-heal", () => {
  it("self-heals a child toward the bucket its authored status maps to", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "In Progress"); // epic already at target
    seam.statusByKey.set("DS-50", "To Do"); // child needs to move
    seam.legalStatuses.add("In Review");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    setIssue("auth", "001.md", { status: "in-review", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "in-progress", "Auth", [issue("001.md", "in-review")])),
    );

    expect(delta.childrenTransitioned).toEqual([{ key: "DS-50", to: "In Review" }]);
    expect(seam.statusByKey.get("DS-50")).toBe("In Review");
    // The epic was already at its target, so only the child moved.
    expect(delta.transitioned).toEqual([]);
  });

  it("does not transition a child already at its target status", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "In Progress");
    seam.statusByKey.set("DS-50", "In Progress");
    seam.legalStatuses.add("In Progress");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    setIssue("auth", "001.md", { status: "in-progress", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "in-progress", "Auth", [issue("001.md", "in-progress")])),
    );

    expect(delta.childrenTransitioned).toEqual([]);
    expect(seam.calls).not.toContain("transition:DS-50->In Progress");
  });

  it("degrades an unavailable child transition to a logged no-op — never a throw, never human-review", async () => {
    const seam = new FakeJiraSeam();
    seam.statusByKey.set("DS-9", "In Progress");
    seam.statusByKey.set("DS-50", "To Do");
    // "In Review" is NOT legal here ⇒ seam.transition throws.
    const { reconciler, set, setIssue, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });
    // human-review is the low-noise fold: it must appear simply as In Review.
    setIssue("auth", "001.md", { status: "human-review", childKey: "DS-50" });

    const delta = await reconciler.reconcile(
      board(prd("auth", "in-progress", "Auth", [issue("001.md", "human-review")])),
    );

    expect(delta.childrenTransitioned).toEqual([]);
    expect(seam.statusByKey.get("DS-50")).toBe("To Do"); // unchanged
    expect(logs.join("\n")).toMatch(/no-op/i);
    // human-review folds into In Review — the mirror never surfaces it distinctly.
    expect(seam.calls).toContain("transition:DS-50->In Review");
    expect(seam.calls).not.toContain("transition:DS-50->human-review");
  });

  it("creates the child but skips self-heal when the Issue's status is unreadable", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, setIssue, childKeyOf, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { body: "Prose only, no status." }); // no status

    const delta = await reconciler.reconcile(
      board(prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")])),
    );

    // The child is still created (create-on-first-appearance is status-agnostic)…
    expect(delta.childrenCreated).toEqual([{ issue: "001.md", key: "DS-101" }]);
    expect(childKeyOf("auth", "001.md")).toBe("DS-101");
    // …but its status is never driven anywhere, and the skip is logged.
    expect(delta.childrenTransitioned).toEqual([]);
    expect(seam.calls.some((c) => c.startsWith("transition:DS-101"))).toBe(false);
    expect(logs.join("\n")).toMatch(/status could not be read/i);
  });

  it("terminates the child backref write-back self-scan as a zero-JIRA no-op", async () => {
    const seam = new FakeJiraSeam();
    seam.projectByBoard.set("34", "DS");
    const { reconciler, set, setIssue } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }) });
    setIssue("auth", "001.md", { status: "backlog", body: "P" });
    const b = board(
      prd("auth", "backlog", "Auth", [issue("001.md", "backlog", "One")]),
    );

    // First pass creates the epic + child (writing both backrefs).
    await reconciler.reconcile(b);
    const callsAfterFirst = seam.calls.length;

    // The backref write-back fires a re-scan → a second reconcile. With both
    // backrefs now present and everything already at target, it writes nothing.
    const second = await reconciler.reconcile(b);

    expect(second.childrenCreated).toEqual([]);
    expect(second.childrenTransitioned).toEqual([]);
    expect(
      seam.calls.slice(callsAfterFirst).filter((c) => c.startsWith("createChild")),
    ).toEqual([]);
    expect(
      seam.calls.slice(callsAfterFirst).filter((c) => c.startsWith("transition")),
    ).toEqual([]);
  });
});
