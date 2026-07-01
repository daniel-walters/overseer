import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  createMirrorReconciler,
  type MirrorFileState,
} from "./mirrorReconciler.js";
import type {
  CreateEpicInput,
  JiraSeam,
} from "./jiraSeam.js";
import type { JiraOptIn } from "../issueFile.js";
import type { Board, PRD } from "../model.js";

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
  /** key → current status name; a created or pre-seeded epic lives here. */
  readonly epics = new Map<string, string>();
  /** Target status names the workflow can legally transition to; others throw. */
  readonly legalStatuses = new Set<string>();
  /** The status a freshly-created epic lands in. */
  initialStatus = "To Do";
  /** When set, `createEpic` throws — a simulated acli failure. */
  failCreate = false;
  /** Ordered record of every seam call. */
  readonly calls: string[] = [];
  /** The inputs `createEpic` was called with, for summary/project assertions. */
  readonly created: CreateEpicInput[] = [];
  private seq = 0;

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
    this.epics.set(key, this.initialStatus);
    return key;
  }

  async currentStatus(key: string): Promise<string | undefined> {
    this.calls.push(`currentStatus:${key}`);
    return this.epics.get(key);
  }

  async transition(key: string, toStatus: string): Promise<void> {
    this.calls.push(`transition:${key}->${toStatus}`);
    if (!this.legalStatuses.has(toStatus)) {
      throw new Error(`illegal transition to ${toStatus}`);
    }
    this.epics.set(key, toStatus);
  }
}

/** A minimal PRD; the mirror only reads id, title, and lane. */
function prd(id: string, lane: PRD["lane"], title = id): PRD {
  return { id, title, lane, issues: [] };
}

function board(...prds: PRD[]): Board {
  return { prds };
}

/**
 * Build a reconciler over an in-memory file store, returning the reconciler plus
 * handles to inspect/seed the store (the prd.md opt-in + epic backref) and the
 * captured log lines.
 */
function harness(seam: FakeJiraSeam, defaultBoard?: string) {
  const files = new Map<string, MirrorFileState>();
  const logs: string[] = [];
  const set = (id: string, state: MirrorFileState) =>
    files.set(join(ROOT, id), state);
  const reconciler = createMirrorReconciler({
    root: ROOT,
    seam,
    defaultBoard,
    readMirror: (prdDir) => files.get(prdDir) ?? {},
    writeEpic: (prdDir, key) => {
      const prev = files.get(prdDir) ?? {};
      files.set(prdDir, { ...prev, epicKey: key });
    },
    log: (m) => logs.push(m),
  });
  const epicKeyOf = (id: string) => files.get(join(ROOT, id))?.epicKey;
  return { reconciler, set, logs, epicKeyOf };
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
    expect(delta).toEqual({ created: [], transitioned: [] });
  });

  it("never creates a second epic when the backref is already present", async () => {
    const seam = new FakeJiraSeam();
    seam.epics.set("DS-9", "To Do");
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
    expect(seam.epics.get("DS-1")).toBe("In Progress");
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
    seam.epics.set("DS-9", "To Do"); // someone dragged it back
    seam.legalStatuses.add("Done");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "done")));

    expect(delta.transitioned).toEqual([{ key: "DS-9", to: "Done" }]);
    expect(seam.epics.get("DS-9")).toBe("Done");
  });

  it("does not transition an epic already at its target status", async () => {
    const seam = new FakeJiraSeam();
    seam.epics.set("DS-9", "In Progress");
    seam.legalStatuses.add("In Progress");
    const { reconciler, set } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "in-progress")));

    expect(delta.transitioned).toEqual([]);
    expect(seam.calls).not.toContain("transition:DS-9->In Progress");
  });

  it("degrades an unavailable target status to a logged no-op, never a throw", async () => {
    const seam = new FakeJiraSeam();
    seam.epics.set("DS-9", "To Do");
    // "Done" is NOT a legal transition here ⇒ seam.transition throws.
    const { reconciler, set, logs } = harness(seam);
    set("auth", { optIn: optIn({ board: "34" }), epicKey: "DS-9" });

    const delta = await reconciler.reconcile(board(prd("auth", "done")));

    // Attempted, but the workflow lacks the status: no crash, no delta, logged.
    expect(delta.transitioned).toEqual([]);
    expect(seam.epics.get("DS-9")).toBe("To Do"); // unchanged
    expect(logs.join("\n")).toMatch(/no-op/i);
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
