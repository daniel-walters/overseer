import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import matter from "gray-matter";

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

/**
 * Read a single PRD directory into a {@link DispatchView}.
 *
 * A pure path → view function with no side effects: it reads the PRD body and
 * each Issue's raw `status`, `blocked_by`, `repo`, body, and file path. It does
 * not consume or modify the board model — dispatch fields never leak into the
 * lean {@link Issue}.
 */
export function readDispatchView(prdDir: string): DispatchView {
  const { data: prdData, content: prdBody } = matter(
    readFileSync(join(prdDir, "prd.md"), "utf8"),
  );
  const prdTitle =
    typeof prdData.title === "string" ? prdData.title : basename(prdDir);

  const files = readdirSync(prdDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  const issues = files.map((name) => readIssue(join(prdDir, name), name));

  return { prdTitle, prdBody, issues };
}

function readIssue(path: string, fileName: string): DispatchIssue {
  const { data, content } = matter(readFileSync(path, "utf8"));

  return {
    id: fileName,
    title: typeof data.title === "string" ? data.title : fileName,
    path,
    status: typeof data.status === "string" ? data.status : undefined,
    blockedBy: parseBlockedBy(data.blocked_by),
    repo: typeof data.repo === "string" ? data.repo : undefined,
    worktree: typeof data.worktree === "string" ? data.worktree : undefined,
    branch: typeof data.branch === "string" ? data.branch : undefined,
    deviation: typeof data.deviation === "string" ? data.deviation : undefined,
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
