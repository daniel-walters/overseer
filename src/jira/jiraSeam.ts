import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The single injectable I/O port for the JIRA mirror (ADR 0028), acli-backed —
 * the mirror's analogue of the dispatch {@link import("../dispatch/gitSetup.js").GitSeam}
 * and the Linked-PR {@link import("../dispatch/linkedPr.js").PrSeam}. All JIRA
 * I/O flows through here so the {@link import("./mirrorReconciler.js").MirrorReconciler}
 * is testable against a fake with no live JIRA, and so the query mechanism (acli
 * today, a REST token later — ADR 0028) can change behind a stable interface.
 *
 * acli owns authentication (an OAuth/API-token session the user configures once),
 * so this seam handles **no credential** — Overseer never sees one. This
 * foundation slice exposes only the epic-tracer operations; child-issue creation,
 * JQL cache seeding, and sprint placement extend the interface in later slices.
 *
 * Failure contract: every method **throws** (rejects) on failure (a missing/unauthed
 * acli, a non-existent board, an illegal transition, a network error). The reconciler
 * wraps each PRD's reconcile in a try/catch, so a throw becomes a *logged no-op*
 * that never takes down the board (ADR 0028) — the seam stays honest about
 * failure and the reconciler owns the degradation.
 *
 * Every method is **async**: acli is a real subprocess round-trip (up to
 * {@link ACLI_TIMEOUT_MS}), and the mirror runs fire-and-forget off the render
 * loop (ADR 0028) — a synchronous shell-out would freeze Ink's render/input
 * handling for the call's whole duration. Awaiting here yields to the event loop
 * between every acli call, so the board keeps rendering and taking input while
 * the mirror talks to JIRA.
 */
export interface JiraSeam {
  /**
   * Resolve the destination project *key* from a board id — the board→project
   * location lookup (ADR 0028), so a PRD need only name its `board` in the common
   * case. Resolves to the board's first associated project's key. Rejects if the
   * board has no project or acli fails.
   */
  resolveProject(board: string): Promise<string>;
  /**
   * Create a JIRA **epic** for a PRD and resolve to its new key (e.g. `DS-100`).
   * The epic is the PRD's mirrored feature-level rollup; its status is driven
   * separately via {@link transition}. Rejects on any acli failure.
   */
  createEpic(input: CreateEpicInput): Promise<string>;
  /**
   * The named status the given issue currently sits in (e.g. `"In Progress"`), or
   * `undefined` when it can't be read. The reconciler compares this against the
   * lane's target status to decide whether a self-healing transition is needed —
   * so an unreadable status degrades to *no transition* rather than a wrong one.
   */
  currentStatus(key: string): Promise<string | undefined>;
  /**
   * Drive the issue to the named target status via acli (which resolves the legal
   * transition for the name). **Rejects** when the status is unreachable or absent
   * from the workflow — the reconciler catches that as a logged no-op, the
   * graceful degradation the mirror promises. Idempotence (not re-firing when
   * already at the target) is the reconciler's job, via {@link currentStatus}.
   */
  transition(key: string, toStatus: string): Promise<void>;
}

/** The fields the mirror supplies when creating an epic. */
export interface CreateEpicInput {
  /** The destination project key (from {@link JiraSeam.resolveProject} or an override). */
  readonly project: string;
  /** The epic summary — the PRD's derived title. */
  readonly summary: string;
  /**
   * The epic description in plain text — the human-readable plan. Optional; a PRD
   * with no body prose creates a summary-only epic.
   */
  readonly description?: string;
}

/**
 * How long to wait for any single acli shell-out before giving up. The mirror
 * runs fire-and-forget off the scan loop, but a hung acli must still fail closed
 * rather than pin a subprocess forever; on timeout `execFileSync` throws, which
 * the reconciler absorbs as a logged no-op.
 */
const ACLI_TIMEOUT_MS = 15000;

/** Cap on captured acli stdout — a work item / project payload is small; overflow throws. */
const ACLI_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The `projects` array key in `acli jira board list-projects --json` output.
 * Parse the first project's `key`, or `undefined` when the board lists none or
 * the output is unparseable/shapeless. Total over bad input so a `resolveProject`
 * caller degrades honestly rather than crashing on an acli hiccup.
 */
export function parseBoardProject(json: string): string | undefined {
  const parsed = tryParse(json);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return undefined;
  return firstKey(projects);
}

/**
 * Parse the status *name* out of `acli jira workitem view --fields status --json`
 * output: the name lives at `fields.status.name`. Returns `undefined` for missing
 * or unparseable output, so an unreadable status becomes *no transition* upstream.
 */
export function parseWorkItemStatus(json: string): string | undefined {
  const parsed = tryParse(json);
  const fields = (parsed as { fields?: { status?: { name?: unknown } } })
    ?.fields;
  const name = fields?.status?.name;
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

/**
 * Recover the created epic's key from `acli jira workitem create --json` output.
 * Tolerant of the plausible shapes: a JSON object with a `key`, or a
 * single-element array of such objects. `undefined` when no key is found there,
 * so a malformed create is a logged no-op rather than a bogus backref written to
 * disk.
 *
 * The regex fallback (scanning for a `PROJ-123`-shaped substring) applies **only**
 * when the output isn't JSON at all — a plain human-readable success line.
 * Once the output parses as JSON, its shape is trusted and nothing else: scanning
 * a *parsed* payload's raw text for a stray key-shaped substring would just as
 * happily match a key mentioned in an unrelated error message (e.g. "related to
 * DS-42, permission denied") and hand back that wrong key as if it were the
 * epic just created, silently mirroring the PRD to someone else's ticket.
 */
export function parseCreatedKey(output: string): string | undefined {
  const parsed = tryParse(output);
  if (parsed !== undefined) {
    if (Array.isArray(parsed)) return firstKey(parsed);
    if (parsed !== null && typeof parsed === "object") {
      const key = (parsed as { key?: unknown }).key;
      return typeof key === "string" && key.trim() !== "" ? key : undefined;
    }
    return undefined;
  }
  // Not parseable as JSON: a plain success line. Scan it for a JIRA key.
  return output.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
}

/** The `key` of the first array element that carries a non-blank string `key`. */
function firstKey(items: readonly unknown[]): string | undefined {
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key === "string" && key.trim() !== "") return key;
  }
  return undefined;
}

/** JSON.parse that yields `undefined` instead of throwing on bad input. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The production acli-backed {@link JiraSeam}: each method shells out to `acli`
 * and parses its `--json` output through the tolerant parsers above. This is the
 * un-fakeable subprocess boundary — kept thin and excluded from unit tests exactly
 * as {@link import("../dispatch/linkedPr.js").realPrSeam} and the real `GitSeam`
 * are; the testable logic lives in the exported parsers, and a gated real-acli
 * integration test exercises the round-trip end-to-end.
 *
 * Every call is bounded by {@link ACLI_TIMEOUT_MS} / {@link ACLI_MAX_BUFFER} and
 * lets failures throw (acli missing, unauthed, a bad board, an illegal transition,
 * network) — the reconciler turns each throw into a logged no-op so the board is
 * never taken down (ADR 0028).
 */
export const realJiraSeam: JiraSeam = {
  async resolveProject(board: string): Promise<string> {
    const out = await runAcli([
      "jira",
      "board",
      "list-projects",
      "--id",
      board,
      "--json",
    ]);
    const project = parseBoardProject(out);
    if (project === undefined) {
      throw new Error(`no project found for JIRA board ${board}`);
    }
    return project;
  },

  async createEpic(input: CreateEpicInput): Promise<string> {
    const args = [
      "jira",
      "workitem",
      "create",
      "--type",
      "Epic",
      "--project",
      input.project,
      "--summary",
      input.summary,
      "--json",
    ];
    if (input.description !== undefined && input.description.trim() !== "") {
      args.push("--description", input.description);
    }
    const key = parseCreatedKey(await runAcli(args));
    if (key === undefined) {
      throw new Error(
        `could not read the created epic key from acli (project ${input.project})`,
      );
    }
    return key;
  },

  async currentStatus(key: string): Promise<string | undefined> {
    return parseWorkItemStatus(
      await runAcli(["jira", "workitem", "view", key, "--fields", "status", "--json"]),
    );
  },

  async transition(key: string, toStatus: string): Promise<void> {
    // acli resolves the legal transition for the named status and confirms with
    // `--yes`; an unreachable/absent status makes acli exit non-zero → throw →
    // the reconciler logs a no-op.
    await runAcli([
      "jira",
      "workitem",
      "transition",
      "--key",
      key,
      "--status",
      toStatus,
      "--yes",
    ]);
  },
};

/**
 * Run one `acli` invocation, resolving to stdout; rejects on any
 * non-zero/timeout/overflow. Uses the async `execFile` (never `execFileSync`) so
 * the mirror's subprocess round-trip never blocks Node's event loop — the render
 * loop and keyboard input stay live for the whole call (ADR 0028: "the board
 * never blocks on it").
 */
async function runAcli(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("acli", args as string[], {
    encoding: "utf8",
    timeout: ACLI_TIMEOUT_MS,
    maxBuffer: ACLI_MAX_BUFFER,
  });
  return stdout;
}
