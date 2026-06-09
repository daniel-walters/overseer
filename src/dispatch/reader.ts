import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  FIELD,
  readPresentString,
  readString,
  safeMatter,
} from "../issueFile.js";

/**
 * Re-exported from the shared {@link import("../issueFile.js")} access layer:
 * dispatch and review code that already imports the reader keeps a single import
 * site for "is this handoff field recorded?".
 */
export { hasValue } from "../issueFile.js";

/**
 * One Issue as the dispatcher needs to see it — a richer record than the lean
 * board {@link Issue}. The dispatch reader parses frontmatter independently of
 * the scanner (see CONTEXT.md / ADR 0002): the board model carries only what
 * the kanban renders, while dispatch needs the raw `status`, the `blocked_by`
 * dependency list, the target `repo`, and the bodies to build prompts.
 */
export interface DispatchIssue {
  /** Identity: the Issue filename (e.g. `002-payment-intent.md`). */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the filename. */
  readonly title: string;
  /** Absolute path to the Issue file. */
  readonly path: string;
  /** The raw authored `status` string, or undefined if absent. */
  readonly status: string | undefined;
  /**
   * Sibling Issue filenames this Issue is blocked by. The full filename is the
   * reference handle — the `NNN-` sort prefix is NOT treated as an identifier.
   * Empty when `blocked_by` is absent.
   */
  readonly blockedBy: readonly string[];
  /** The target repo (path or git URL) the work happens in, or undefined. */
  readonly repo: string | undefined;
  /**
   * The implementor's recorded worktree path, or undefined before completion.
   * Recorded — never derived — because `claude --bg` worktree/branch names are
   * random (ADR 0006). The reviewer checks this out to review.
   */
  readonly worktree: string | undefined;
  /** The implementor's recorded branch to merge, or undefined. See {@link worktree}. */
  readonly branch: string | undefined;
  /**
   * The implementor's deviation note, present only if it strayed from the
   * Issue's planned approach. Its mere presence (not any value) forces a human
   * review; undefined when the implementor followed the plan.
   */
  readonly deviation: string | undefined;
  /** The Issue's markdown body (frontmatter stripped). */
  readonly body: string;
}

/**
 * A PRD as the dispatcher needs to see it: the PRD body plus a richer record
 * per Issue. Produced by {@link readDispatchView} from a PRD directory path.
 */
export interface DispatchView {
  /** The PRD's display title: `title` frontmatter, falling back to the dir name. */
  readonly prdTitle: string;
  /** The PRD's markdown body (frontmatter stripped). */
  readonly prdBody: string;
  /** Every Issue in the PRD, ordered by `NNN-` filename prefix. */
  readonly issues: readonly DispatchIssue[];
}

/** Read a PRD directory's `prd.md` into its display title and body. */
export function readPrdMeta(prdDir: string): {
  prdTitle: string;
  prdBody: string;
} {
  const { data, content } = safeMatter(
    readFileSync(join(prdDir, "prd.md"), "utf8"),
  );
  return {
    prdTitle: readString(data, FIELD.title) ?? basename(prdDir),
    prdBody: content,
  };
}

/** Read one Issue file in a PRD directory into a {@link DispatchIssue}. */
export function readDispatchIssue(
  prdDir: string,
  fileName: string,
): DispatchIssue {
  return readIssue(join(prdDir, fileName), fileName);
}

/**
 * Read a single PRD directory into a {@link DispatchView}.
 *
 * A pure path → view function with no side effects: it reads the PRD body and
 * each Issue's raw `status`, `blocked_by`, `repo`, body, and file path. It does
 * not consume or modify the board model — dispatch fields never leak into the
 * lean {@link Issue}.
 */
export function readDispatchView(prdDir: string): DispatchView {
  const { prdTitle, prdBody } = readPrdMeta(prdDir);

  const files = readdirSync(prdDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  const issues = files.map((name) => readIssue(join(prdDir, name), name));

  return { prdTitle, prdBody, issues };
}

function readIssue(path: string, fileName: string): DispatchIssue {
  const { data, content } = safeMatter(readFileSync(path, "utf8"));

  return {
    id: fileName,
    title: readString(data, FIELD.title) ?? fileName,
    path,
    status: readString(data, FIELD.status),
    blockedBy: parseBlockedBy(data[FIELD.blockedBy]),
    repo: readString(data, FIELD.repo),
    worktree: readString(data, FIELD.worktree),
    branch: readString(data, FIELD.branch),
    // A blank `deviation:` is treated as absent: only a real, non-empty note
    // forecloses the clean auto-merge path (its mere presence forces a human
    // review), so an empty-string field must not silently escalate.
    deviation: readPresentString(data, FIELD.deviation),
    body: content,
  };
}

/**
 * Parse the `blocked_by` frontmatter into a list of sibling filenames. Each
 * entry is a full filename used verbatim as the reference — the `NNN-` prefix
 * is part of the value, never split off.
 *
 * A bare string (a list written as a scalar by mistake) is read as a
 * single-entry list rather than dropped: it still names a dependency, and
 * silently parsing it to `[]` would let the frontier treat a typo as unblocked
 * — the opposite of fail-safe. A missing value yields an empty list.
 */
function parseBlockedBy(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
