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
 * so this seam handles **no credential** — Overseer never sees one. It exposes
 * epic/child creation, the JQL {@link JiraSeam.searchStatuses} that seeds the
 * reconciler's diff-gate cache, and status transitions; sprint placement extends
 * the interface in a later slice.
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
   * **home/location** lookup (ADR 0028, ADR 0032), so a PRD need only name its
   * `board` in the common case. A single-project board resolves to its one project;
   * a multi-project filter board resolves to the project named by the board's
   * *location*, cross-referenced against the board's project list for a validated
   * key (never blindly the first-listed project — see {@link resolveProjectKey}).
   * Rejects when the project can't be resolved (an ambiguous board with no override,
   * or an acli failure), which the reconciler absorbs as a logged no-op.
   */
  resolveProject(board: string): Promise<string>;
  /**
   * Create a JIRA **epic** for a PRD and resolve to its new key (e.g. `DS-100`).
   * The epic is the PRD's mirrored feature-level rollup; its status is driven
   * separately via {@link transition}. Rejects on any acli failure.
   */
  createEpic(input: CreateEpicInput): Promise<string>;
  /**
   * Create a JIRA **child issue** nested under a PRD's epic via JIRA Cloud's native
   * `parent` field (ADR 0028, user story 26) and resolve to its new key. The
   * reconciler creates one per Issue of an opted-in PRD (create-on-first-appearance,
   * incl. backlog), only ever *after* the epic exists (epic-before-child ordering) —
   * so a child is never parented to a not-yet-created epic. Its status is driven
   * separately via {@link transition}, reusing the same generic ops as the epic.
   * Rejects on any acli failure.
   */
  createChildIssue(input: CreateChildInput): Promise<string>;
  /**
   * Fetch the current named status of each given issue key in **one** JQL search —
   * the batched, board-open seed of the reconciler's last-known-bucket cache (ADR
   * 0028). The reconciler collects every mirrored PRD's epic + child backref, seeds
   * the cache from this single call, then diffs each scan against the cache **in
   * memory** — so a steady-state scan that crosses no bucket makes zero JIRA calls.
   *
   * Resolves to one {@link JiraStatus} per *found* key (a key JIRA no longer knows —
   * deleted, or index-lagged — is simply omitted; a found key whose status can't be
   * parsed carries an `undefined` status). An empty `keys` list resolves to `[]`
   * without shelling out. Rejects only on an acli/search failure, which the
   * reconciler absorbs as a logged no-op that leaves the cache empty (it degrades to
   * driving transitions rather than crashing).
   */
  searchStatuses(keys: readonly string[]): Promise<readonly JiraStatus[]>;
  /**
   * Drive the issue to the named target status via acli (which resolves the legal
   * transition for the name). **Rejects** when the status is unreachable or absent
   * from the workflow — the reconciler catches that as a logged no-op, the
   * graceful degradation the mirror promises. Idempotence (not re-firing when
   * already at the target) is the reconciler's job, via its diff against the
   * last-known-bucket cache that {@link searchStatuses} seeds.
   */
  transition(key: string, toStatus: string): Promise<void>;
  /**
   * Resolve the board's live **active sprint** id (JIRA Agile API via acli), or
   * `undefined` when the board has no active sprint — the reconciler treats the
   * latter as a logged no-op that leaves the child in the backlog (user story 7).
   * Used only for `target: sprint` PRDs, at child-create time. Rejects on an acli
   * failure (unauthed, bad board, network), which the reconciler catches as a
   * logged no-op just like {@link resolveProject}.
   */
  resolveActiveSprint(board: string): Promise<string | undefined>;
  /**
   * Place a child issue into a sprint (JIRA Agile API via acli) — the sprint
   * resolved by {@link resolveActiveSprint}. Called **once at create** for a
   * `target: sprint` PRD's child and never again (placement is set once; the team
   * owns subsequent sprint moves — user story 8). Never called for an epic, which
   * is never sprinted. Rejects on any acli failure, which the reconciler catches
   * as a logged no-op (the child simply stays where JIRA created it).
   */
  assignToSprint(sprintId: string, key: string): Promise<void>;
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

/** One work item's key and its current named JIRA status, from {@link JiraSeam.searchStatuses}. */
export interface JiraStatus {
  /** The work item's JIRA key (e.g. `DS-50`). */
  readonly key: string;
  /** Its current named status (e.g. `"In Progress"`), or `undefined` when unreadable. */
  readonly status: string | undefined;
}

/** The fields the mirror supplies when creating a child issue under an epic. */
export interface CreateChildInput {
  /**
   * The destination project key — the epic's project, so the child lands beside it.
   * The reconciler derives it from the epic key's prefix (a JIRA key is
   * `PROJECT-NUMBER`), so a child under an already-linked epic needs no extra
   * board→project lookup.
   */
  readonly project: string;
  /** The parent epic's key (native `parent` field) — the epic-before-child link. */
  readonly parent: string;
  /** The child summary — the Issue's `title`. */
  readonly summary: string;
  /**
   * The child description in plain text — the Issue **body prose with frontmatter
   * stripped**, so no machine state leaks into the human-readable ticket. Optional;
   * a body-less Issue creates a summary-only child.
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
 * The outcome of resolving a board to its destination project (ADR 0028, ADR 0032):
 * either a validated project `key`, or an `ambiguous` verdict carrying a
 * human-readable `reason` for the mirror log. The reconciler treats `ambiguous`
 * exactly as it treats any other resolution failure — a logged no-op — so the
 * mirror's low-noise failure behavior is unchanged.
 */
export type ProjectResolution =
  | { readonly kind: "resolved"; readonly key: string }
  | { readonly kind: "ambiguous"; readonly reason: string };

/**
 * Resolve a board's destination project *key* from the two acli JSON payloads —
 * `acli jira board list-projects` (the authoritative `{key, name}` set the board
 * filters over) and `acli jira board get` (the board's `location`, its home
 * project) — plus an optional author-supplied `project` override. A **pure**
 * function over those strings with no I/O, so the board→project derivation that
 * once mis-targeted a multi-project board is unit-testable in isolation (ADR 0032).
 *
 * The rules, in precedence order:
 * - An `override` present (non-blank) → that project, always winning. It is the
 *   deliberate fallback for a board whose home project genuinely can't be resolved
 *   (user story 8), so it never even consults the payloads.
 * - Exactly one project listed → that project (the common single-project board,
 *   zero-config — user story 7), regardless of location.
 * - Multiple listed → the entry whose key or name matches the board's `location`,
 *   cross-referenced against the list for a *validated* key (never blindly the
 *   first-listed project — the bug that sent board 681's PRD to the co-listed
 *   `CABB` bug project instead of `ESD`).
 * - Otherwise (no projects, or multiple with no location match and no override) →
 *   `ambiguous`, which the reconciler logs as a no-op.
 */
export function resolveProjectKey(input: {
  readonly boardGet: string;
  readonly listProjects: string;
  readonly override?: string;
}): ProjectResolution {
  // An override always wins — before the payloads are even consulted — so it is a
  // robust fallback for a board whose home project can't be resolved (user story 8).
  const override = input.override?.trim();
  if (override !== undefined && override !== "") {
    return { kind: "resolved", key: override };
  }
  const projects = parseBoardProjects(input.listProjects);
  const [sole] = projects;
  if (projects.length === 1 && sole !== undefined) {
    return { kind: "resolved", key: sole.key };
  }
  if (projects.length === 0) {
    return { kind: "ambiguous", reason: "board lists no projects" };
  }
  // Multiple projects (a filter board): pick the one the board's location names,
  // cross-referenced against the list for a validated key — never the first listed.
  const location = parseBoardLocation(input.boardGet);
  const matched = matchLocation(projects, location);
  const [soleMatch] = matched;
  if (matched.length === 1 && soleMatch !== undefined) {
    return { kind: "resolved", key: soleMatch.key };
  }
  const listed = projects.map((p) => p.key).join(", ");
  return {
    kind: "ambiguous",
    reason:
      location === undefined
        ? `board lists multiple projects (${listed}) and has no location to disambiguate — supply a project override`
        : `board location "${location}" matched ${matched.length} of the listed projects (${listed}) — supply a project override`,
  };
}

/**
 * The listed projects the board's `location` names — the location cross-referenced
 * against the authoritative project set for a *validated* key. JIRA renders a
 * project-location board as `"<Project Name> (<KEY>)"`, so the trailing
 * parenthetical key is the strongest, most precise signal; failing that, the
 * location naming a project's key or full name outright also matches. Returns every
 * matching project (usually one), so the caller can treat zero or several as
 * ambiguous rather than guessing.
 */
function matchLocation(
  projects: readonly BoardProject[],
  location: string | undefined,
): BoardProject[] {
  const loc = location?.trim();
  if (loc === undefined || loc === "") return [];
  // Strongest signal: a trailing "(KEY)" whose key a listed project carries exactly.
  const parenKey = loc.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  if (parenKey !== undefined && parenKey !== "") {
    const byKey = projects.filter((p) => eqIgnoreCase(p.key, parenKey));
    if (byKey.length > 0) return byKey;
  }
  // Otherwise: the location names a project's key, or contains its full name.
  const lower = loc.toLowerCase();
  return projects.filter(
    (p) =>
      eqIgnoreCase(p.key, loc) ||
      (p.name !== "" && lower.includes(p.name.toLowerCase())),
  );
}

/** Case-insensitive string equality. */
function eqIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The board's home-project `location` string from `acli jira board get --json`
 * (e.g. `"Team Survey Design (ESD)"`), or `undefined` when the field is absent or
 * the output is unparseable/shapeless — so a board with no readable location falls
 * through to the ambiguous verdict rather than crashing.
 */
function parseBoardLocation(json: string): string | undefined {
  const parsed = tryParse(json);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const location = (parsed as { location?: unknown }).location;
  return typeof location === "string" && location.trim() !== ""
    ? location
    : undefined;
}

/**
 * The `projects` array of `acli jira board list-projects --json` as `{key, name}`
 * pairs — the authoritative project set a board filters over. Skips entries with no
 * usable string `key`, and yields `[]` for unparseable/shapeless output, so the
 * pure resolver degrades honestly rather than crashing on an acli hiccup.
 */
function parseBoardProjects(json: string): BoardProject[] {
  const parsed = tryParse(json);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return [];
  const rows: BoardProject[] = [];
  for (const item of projects) {
    if (item === null || typeof item !== "object") continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key !== "string" || key.trim() === "") continue;
    const name = (item as { name?: unknown }).name;
    rows.push({
      key: key.trim(),
      name: typeof name === "string" ? name.trim() : "",
    });
  }
  return rows;
}

/** One project a board filters over: its JIRA `key` and display `name`. */
interface BoardProject {
  readonly key: string;
  readonly name: string;
}

/**
 * Parse `acli jira workitem search --fields key,status --json` output into one
 * {@link JiraStatus} per row — the batched cache seed. The status name lives at
 * `fields.status.name` (the same path a single-item view uses). A row with no
 * string `key` is skipped (it names no item to cache); a keyed row whose status is
 * missing/blank keeps the key with an `undefined` status (the item exists, its
 * status is just unknown). Unparseable or non-array output yields `[]`, so a
 * search hiccup seeds an empty cache rather than throwing.
 */
export function parseSearchStatuses(json: string): JiraStatus[] {
  const parsed = tryParse(json);
  if (!Array.isArray(parsed)) return [];
  const rows: JiraStatus[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key !== "string" || key.trim() === "") continue;
    const name = (item as { fields?: { status?: { name?: unknown } } }).fields
      ?.status?.name;
    rows.push({
      key,
      status: typeof name === "string" && name.trim() !== "" ? name : undefined,
    });
  }
  return rows;
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

/**
 * Recover the board's active-sprint id from `acli jira board list-sprints
 * --state active --json` output. The Agile-API shape is an array of sprint
 * objects under `sprints` (with a `values` fallback, the raw REST key), each
 * carrying a numeric `id`; the first element's id is the board's active sprint
 * (the call already filters to `--state active`). Returns `undefined` for an
 * empty list (no active sprint) or unparseable/shapeless output, so the mirror
 * degrades to a logged no-op — a child without an active sprint stays in the
 * backlog rather than erroring. The numeric id is coerced to its string form,
 * since the seam speaks in string ids throughout.
 */
export function parseActiveSprintId(json: string): string | undefined {
  const parsed = tryParse(json);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const list =
    (parsed as { sprints?: unknown }).sprints ??
    (parsed as { values?: unknown }).values;
  if (!Array.isArray(list)) return undefined;
  return firstSprintId(list);
}

/** The `id` of the first array element that carries a usable sprint id, as a string. */
function firstSprintId(items: readonly unknown[]): string | undefined {
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && id.trim() !== "") return id.trim();
  }
  return undefined;
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
    // The board's project set (what it filters over) always needs reading. Its
    // location (home project) only matters to disambiguate a *multi*-project
    // filter board — a single-project board resolves trivially without it — so
    // `board get` is fetched lazily, only when there's more than one listed
    // project. This keeps the common single-project case's failure surface to
    // just the one acli call it actually needs, rather than making it depend on
    // a `board get` call it never consults. The author-supplied `project`
    // override is handled upstream in the reconciler (which skips this lookup
    // entirely when it is set), so no override is threaded here.
    const listProjects = await runAcli([
      "jira",
      "board",
      "list-projects",
      "--id",
      board,
      "--json",
    ]);
    const boardGet =
      parseBoardProjects(listProjects).length > 1
        ? await runAcli(["jira", "board", "get", "--id", board, "--json"])
        : "{}";
    const resolution = resolveProjectKey({ boardGet, listProjects });
    if (resolution.kind !== "resolved") {
      throw new Error(
        `could not resolve a project for JIRA board ${board}: ${resolution.reason}`,
      );
    }
    return resolution.key;
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

  async createChildIssue(input: CreateChildInput): Promise<string> {
    // A standard `Task` parented to the epic via the native `parent` field (JIRA
    // Cloud — user story 26). Same create shape as an epic, plus `--parent`.
    const args = [
      "jira",
      "workitem",
      "create",
      "--type",
      "Task",
      "--project",
      input.project,
      "--parent",
      input.parent,
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
        `could not read the created child key from acli (parent ${input.parent})`,
      );
    }
    return key;
  },

  async searchStatuses(keys: readonly string[]): Promise<readonly JiraStatus[]> {
    // No keys ⇒ nothing to seed: skip the shell-out entirely (a fresh board with
    // no backrefs yet makes no acli call at open).
    if (keys.length === 0) return [];
    // One JQL clause fetches every mirrored key's status in a single round-trip —
    // `key in (DS-9, DS-50, …)` — the batched seed that lets every later scan diff
    // in memory. `--limit` is sized to the key count so a large PRD isn't truncated.
    const jql = `key in (${keys.join(", ")})`;
    return parseSearchStatuses(
      await runAcli([
        "jira",
        "workitem",
        "search",
        "--jql",
        jql,
        "--fields",
        "key,status",
        "--limit",
        String(keys.length),
        "--json",
      ]),
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

  async resolveActiveSprint(board: string): Promise<string | undefined> {
    // `--state active` filters to the (at most one) active sprint, so the first
    // element of the parsed list is the board's active sprint; an empty list is
    // "no active sprint" → undefined → the reconciler leaves the child in the
    // backlog. An acli failure (unauthed, bad board, network) throws.
    return parseActiveSprintId(
      await runAcli([
        "jira",
        "board",
        "list-sprints",
        "--id",
        board,
        "--state",
        "active",
        "--json",
      ]),
    );
  },

  async assignToSprint(sprintId: string, key: string): Promise<void> {
    // Sprint membership is a JIRA Agile-API operation
    // (`POST /rest/agile/1.0/sprint/{id}/issue`), but acli 1.x exposes **no**
    // command for it: `jira sprint` offers only create/delete/update/view/
    // list-workitems (no add), and `workitem create`/`edit` accept neither a
    // `--sprint` flag nor a `fields` payload (`edit --from-json` rejects an
    // unknown `fields` key), so there is no acli path to place an existing issue
    // into a sprint. This is the loose end the PRD's Further Notes flagged to
    // validate before committing the seam impl — validated here as *unsupported*.
    //
    // Rather than guess an instance-specific Sprint custom-field id (which would
    // risk writing the wrong field), this throws — the reconciler catches it as a
    // logged no-op, so a `target: sprint` child simply stays where JIRA created
    // it (the backlog) until a REST-token `JiraSeam` (the PRD's noted future
    // option) or a future acli sprint-add command implements this operation. The
    // reconciler, the seam interface, and their tests are complete and will drive
    // real sprint placement unchanged the moment such an implementation is wired
    // in — nothing above this boundary needs to change.
    throw new Error(
      `acli exposes no operation to add work item ${key} to sprint ${sprintId}; sprint placement needs a REST-token JiraSeam (see ADR 0028's noted future option)`,
    );
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
