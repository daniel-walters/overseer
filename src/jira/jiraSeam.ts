import { execFileSync } from "node:child_process";

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
 * Failure contract: every method **throws** on failure (a missing/unauthed acli,
 * a non-existent board, an illegal transition, a network error). The reconciler
 * wraps each PRD's reconcile in a try/catch, so a throw becomes a *logged no-op*
 * that never takes down the board (ADR 0028) — the seam stays honest about
 * failure and the reconciler owns the degradation.
 */
export interface JiraSeam {
  /**
   * Resolve the destination project *key* from a board id — the board→project
   * location lookup (ADR 0028), so a PRD need only name its `board` in the common
   * case. Returns the board's first associated project's key. Throws if the board
   * has no project or acli fails.
   */
  resolveProject(board: string): string;
  /**
   * Create a JIRA **epic** for a PRD and return its new key (e.g. `DS-100`). The
   * epic is the PRD's mirrored feature-level rollup; its status is driven
   * separately via {@link transition}. Throws on any acli failure.
   */
  createEpic(input: CreateEpicInput): string;
  /**
   * The named status the given issue currently sits in (e.g. `"In Progress"`), or
   * `undefined` when it can't be read. The reconciler compares this against the
   * lane's target status to decide whether a self-healing transition is needed —
   * so an unreadable status degrades to *no transition* rather than a wrong one.
   */
  currentStatus(key: string): string | undefined;
  /**
   * Drive the issue to the named target status via acli (which resolves the legal
   * transition for the name). **Throws** when the status is unreachable or absent
   * from the workflow — the reconciler catches that as a logged no-op, the
   * graceful degradation the mirror promises. Idempotence (not re-firing when
   * already at the target) is the reconciler's job, via {@link currentStatus}.
   */
  transition(key: string, toStatus: string): void;
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
 * Tolerant of the plausible shapes: a JSON object with a `key`, a single-element
 * array of such objects, and — belt-and-braces — a plain success line, from which
 * a `PROJ-123` key pattern is scanned. `undefined` when no key is found, so a
 * malformed create is a logged no-op rather than a bogus backref written to disk.
 */
export function parseCreatedKey(output: string): string | undefined {
  const parsed = tryParse(output);
  if (Array.isArray(parsed)) {
    const key = firstKey(parsed);
    if (key !== undefined) return key;
  } else if (parsed !== null && typeof parsed === "object") {
    const key = (parsed as { key?: unknown }).key;
    if (typeof key === "string" && key.trim() !== "") return key;
  }
  // Fallback: scan any output (JSON we couldn't key off, or a human line) for a
  // JIRA key pattern (uppercase project prefix + number).
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
  resolveProject(board: string): string {
    const out = runAcli([
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

  createEpic(input: CreateEpicInput): string {
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
    const key = parseCreatedKey(runAcli(args));
    if (key === undefined) {
      throw new Error(
        `could not read the created epic key from acli (project ${input.project})`,
      );
    }
    return key;
  },

  currentStatus(key: string): string | undefined {
    return parseWorkItemStatus(
      runAcli(["jira", "workitem", "view", key, "--fields", "status", "--json"]),
    );
  },

  transition(key: string, toStatus: string): void {
    // acli resolves the legal transition for the named status and confirms with
    // `--yes`; an unreachable/absent status makes acli exit non-zero → throw →
    // the reconciler logs a no-op.
    runAcli([
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

/** Run one `acli` invocation, returning stdout; throws on any non-zero/timeout/overflow. */
function runAcli(args: readonly string[]): string {
  return execFileSync("acli", args as string[], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: ACLI_TIMEOUT_MS,
    maxBuffer: ACLI_MAX_BUFFER,
  });
}
