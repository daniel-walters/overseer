/**
 * The richer per-Issue and per-PRD records that the dispatch pipeline operates
 * on, distinct from the lean board {@link import("../model.js").Board} model the
 * viewer renders. The dispatch-reader produces these by reading a PRD directory
 * with its frontmatter and bodies intact; the frontier, implementor-prompt, and
 * spawn modules consume them.
 *
 * Kept in their own module so each dispatch slice (built in parallel) shares one
 * input contract rather than redefining the shape.
 */

/**
 * One Issue as the dispatch pipeline sees it: raw authored status plus the
 * fields the viewer ignores (`blocked_by`, `repo`) and the full markdown body.
 */
export interface IssueRecord {
  /** Identity: the Issue filename (e.g. `001-auth.md`). */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the filename slug. */
  readonly title: string;
  /** The raw `status` frontmatter string, unmapped (e.g. `ready-for-agent`). */
  readonly status: string;
  /** Sibling Issue filenames this one is blocked by; empty/absent ⇒ unblocked. */
  readonly blockedBy: readonly string[];
  /** The code repository (path or git URL) the Issue's work happens in. */
  readonly repo?: string;
  /** The Issue's markdown body (frontmatter stripped). */
  readonly body: string;
  /** Absolute path to the Issue file in the Overseer root. */
  readonly path: string;
}

/** The parent PRD as the dispatch pipeline sees it: identity, body, directory. */
export interface PrdRecord {
  /** Identity: the PRD directory name (e.g. `auth-system`). */
  readonly id: string;
  /** Display title: `title` frontmatter, falling back to the directory name. */
  readonly title: string;
  /** The PRD's markdown body (frontmatter stripped). */
  readonly body: string;
}
