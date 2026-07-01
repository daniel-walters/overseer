import { readFileSync, writeFileSync } from "node:fs";
import matter from "gray-matter";

/**
 * The single home for Overseer's on-disk Issue/PRD file contract: how a
 * markdown file's YAML frontmatter is parsed, how individual fields are read out
 * of it, and how the one mutable field (`status`) is rewritten in place.
 *
 * Both readers project from here without re-deriving the format: the scanner
 * builds the lean board {@link import("./model.js").Issue}, and the dispatch
 * reader builds the rich {@link import("./dispatch/reader.js").DispatchIssue}.
 * They keep their own *projections* (the board never carries dispatch fields,
 * see ADR 0002) but share this *access* layer, so the frontmatter format — the
 * field names, how a blank value degrades, how malformed YAML is tolerated, how
 * a status flip preserves comments — is known in exactly one place.
 */

/**
 * The frontmatter field names an Issue (or PRD) file carries. Listed once so a
 * rename is a single edit and every reader/writer agrees on the spelling. The
 * agent prompts (`implementorPrompt`, `reviewerPrompt`) restate these in prose
 * as instructions — that prose is the one copy this module cannot own, because
 * an agent reads English, not a constant.
 */
export const FIELD = {
  title: "title",
  status: "status",
  repo: "repo",
  worktree: "worktree",
  branch: "branch",
  deviation: "deviation",
  reviewVerdict: "review_verdict",
  reviewFindings: "review_findings",
  blockedBy: "blocked_by",
  humanReviewReason: "human_review_reason",
  humanReviewNote: "human_review_note",
  /**
   * The `slice: N-name` value authored by overseer-to-issues, read only by the
   * board's Open PR / Linked PR path to materialize a stack (CONTEXT.md → Slice,
   * ADR 0024). Never written by the board.
   */
  slice: "slice",
  /**
   * The authored `jira` block on `prd.md` — the JIRA-mirror opt-in (ADR 0028): its
   * *presence* opts the PRD into mirroring, its fields (`board`, optional `project`
   * override) steer where. Absent ⇒ the PRD is invisible to the mirror. Parsed via
   * {@link parseJiraOptIn}; never written by the mirror (a human authors it).
   */
  jira: "jira",
  /**
   * The mirror-written epic backref on `prd.md` (ADR 0029): the JIRA key of the
   * epic this PRD is mirrored to. Its presence makes create idempotent —
   * update-or-noop, never a second epic. Written via {@link writeJiraEpic}, read
   * back with {@link readPresentString}. The one bookkeeping key the mirror writes
   * to `prd.md`; it touches no Issue content or status.
   */
  jiraEpic: "jira_epic",
} as const;

/** The untyped frontmatter bag gray-matter parses out of a file. */
export type Frontmatter = { readonly [key: string]: unknown };

/**
 * Parse frontmatter, treating an unparseable file as having none. A single Issue
 * (or PRD) with malformed YAML — e.g. an agent-written `deviation:` whose value
 * contains an unquoted `": "` — must not throw out of a scan/read and take down
 * the whole board on the next watch event; its fields are simply read as absent.
 */
export function safeMatter(raw: string): {
  data: Frontmatter;
  content: string;
} {
  try {
    const { data, content } = matter(raw);
    return { data, content };
  } catch {
    return { data: {}, content: raw };
  }
}

/**
 * Read a string-valued frontmatter field, or `undefined` when it is absent or
 * not a string. A blank string is kept verbatim — use {@link readPresentString}
 * for fields where an empty value should count as absent.
 */
export function readString(
  data: Frontmatter,
  field: string,
): string | undefined {
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * A frontmatter value counts as *present* only when it is a non-blank string.
 * The handoff fields (`worktree`, `branch`, `repo`) and the `deviation` marker
 * use this: a blank `deviation:` must not silently force a human review, and a
 * blank `worktree:` is no worktree at all. Exported standalone so callers
 * holding an already-parsed value (e.g. the review edge checking `issue.repo`)
 * apply the same rule the readers do.
 */
export function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Read a string-valued frontmatter field, collapsing a blank value to
 * `undefined` ({@link hasValue} semantics). For fields where an empty string is
 * indistinguishable from absent.
 */
export function readPresentString(
  data: Frontmatter,
  field: string,
): string | undefined {
  const value = readString(data, field);
  return hasValue(value) ? value : undefined;
}

/**
 * Parse the `blocked_by` frontmatter into a list of sibling filenames. Each
 * entry is a full filename used verbatim as the reference — the `NNN-` prefix
 * is part of the value, never split off.
 *
 * A bare string (a list written as a scalar by mistake) is read as a
 * single-entry list rather than dropped: it still names a dependency, and
 * silently parsing it to `[]` would let a reader treat a typo as unblocked — the
 * opposite of fail-safe. A missing value yields an empty list. Shared by the
 * dispatch reader (the frontier's blocker check) and the scanner (the stalled
 * roll-up) so the two can't drift in how they read the same field.
 */
export function parseBlockedBy(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Rewrite a single Issue file's `status` frontmatter in place, preserving the
 * rest of the file: every other frontmatter key, any inline comments, and the
 * entire markdown body.
 *
 * This is the dispatcher's one sanctioned mutation of an Issue (see ADR 0002):
 * the synchronous `ready-for-agent → in-progress` flip on dispatch, and the
 * `in-progress → ready-for-agent` rollback when a spawn fails. Because the root
 * is filesystem-watched, the write is also the event that moves the card on the
 * live board.
 *
 * When the file already has a `status:` line, only that line is rewritten — a
 * surgical text edit, so hand-authored frontmatter (comments, key order, custom
 * quoting) survives untouched. Round-tripping through a YAML parse + re-dump
 * (gray-matter's `stringify`) would silently drop comments and reflow the block,
 * so that path is used only as a fallback when there is no `status:` line to
 * replace.
 */
export function writeStatus(path: string, status: string): void {
  const original = readFileSync(path, "utf8");
  const replaced = replaceStatusLine(original, status);
  if (replaced !== undefined) {
    writeFileSync(path, replaced);
    return;
  }

  // No existing `status:` line within a frontmatter block: fall back to
  // gray-matter to add one (a freshly added key has no comment to preserve).
  const parsed = matter(original);
  writeFileSync(
    path,
    matter.stringify(parsed.content, { ...parsed.data, [FIELD.status]: status }),
  );
}

/**
 * Escalate an Issue to `human-review` in a single write, recording the
 * escalation reason and a free-text note alongside the status — the same three
 * frontmatter fields the reviewer agent writes when it takes the human-review
 * exit, but written by Overseer when the Reactor enforces the pass cap
 * (`non-convergence`, ADR 0018). Overseer owns this escalation because the count
 * that triggers it lives in Overseer's sidecar, never in the Issue.
 *
 * Unlike {@link writeStatus}'s surgical single-line edit, this rewrites the whole
 * frontmatter block via gray-matter: it adds two keys that were almost certainly
 * absent (`human_review_reason`, `human_review_note`), so there is no inline
 * comment on them to preserve, and the markdown body is round-tripped untouched.
 * Existing keys (repo, worktree, branch, any implementor deviation) are preserved
 * — `human-review` keeps the deviation audit trail intact.
 */
export function writeHumanReview(
  path: string,
  reason: string,
  note: string,
): void {
  const { data, content } = matter(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    matter.stringify(content, {
      ...data,
      [FIELD.status]: "human-review",
      [FIELD.humanReviewReason]: reason,
      [FIELD.humanReviewNote]: note,
    }),
  );
}

/**
 * The JIRA-mirror opt-in a `prd.md` carries in its authored `jira` block (ADR
 * 0028). The *presence* of the block is the opt-in; both fields are optional:
 * `board` defaults to the config's `default_board`, and `project` is the rare
 * override for a filter board spanning projects (normally the project is derived
 * from the board). An empty block ({@link parseJiraOptIn} returns `{}`) is a valid
 * opt-in that defers the board entirely to config.
 */
export interface JiraOptIn {
  readonly board?: string;
  readonly project?: string;
}

/**
 * Parse the authored `jira` block into a {@link JiraOptIn}, or `undefined` when
 * the file carries no `jira` key at all — the opt-out that makes a PRD invisible
 * to the mirror. The block's *presence* is the opt-in (ADR 0028), so a
 * present-but-empty block (`jira:` with no fields, which YAML reads as `null`)
 * returns `{}`: opted in, deferring the board to config.
 *
 * `board` is coerced from a number (board ids are numeric, so `board: 42` and
 * `board: "42"` mean the same board); blank `board`/`project` values collapse to
 * absent ({@link hasValue} semantics), so a stray empty string never becomes a
 * bogus board id or project key. Own-property check (not a bare `in`) so a `jira`
 * that names an `Object.prototype` member can't be mistaken for an opt-in.
 */
export function parseJiraOptIn(data: Frontmatter): JiraOptIn | undefined {
  if (!Object.hasOwn(data, FIELD.jira)) return undefined;
  const block = data[FIELD.jira];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    // Present key, but not a table (empty `jira:` → null, or a scalar): the
    // presence still opts in; there are simply no fields to read.
    return {};
  }
  const table = block as Frontmatter;
  const board = coerceBoardId(table.board);
  const project = readPresentString(table, "project");
  return {
    ...(board !== undefined ? { board } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

/** A board id may be authored as a number or string; coerce to a non-blank string. */
function coerceBoardId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return typeof raw === "string" && hasValue(raw) ? raw.trim() : undefined;
}

/**
 * Write the mirror-owned `jira_epic` backref onto `prd.md` in a single write,
 * recording the JIRA key of the epic the PRD is mirrored to (ADR 0029). Like
 * {@link writeHumanReview} it goes through the `gray-matter` write path — adding
 * (or overwriting) exactly this one bookkeeping key while round-tripping every
 * other frontmatter key (the authored `jira` opt-in block, `title`) and the
 * markdown body untouched. It touches no Issue content or `status`: this is the
 * mirror's sole, write-once-per-PRD reach into the canonical files (ADR 0028's
 * one exception). A present backref is what makes create idempotent, so writing
 * the same key twice is a harmless overwrite, never a second key.
 */
export function writeJiraEpic(path: string, epicKey: string): void {
  const { data, content } = matter(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    matter.stringify(content, { ...data, [FIELD.jiraEpic]: epicKey }),
  );
}

/** Matches a leading frontmatter block delimited by `---` fences. */
const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/;
/** Matches a top-level `status:` line (and its trailing comment) inside it. */
const STATUS_LINE = /^(status:[ \t]*)(\S.*?)([ \t]*(?:#.*)?)$/m;

/**
 * Replace the value of an existing top-level `status:` line inside the file's
 * frontmatter block, leaving everything else byte-for-byte. Returns the new
 * file contents, or `undefined` when there is no frontmatter block or no
 * `status:` line to replace (the caller then falls back to a full re-stringify).
 */
function replaceStatusLine(content: string, status: string): string | undefined {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;

  const block = fm[0];
  const open = fm[1]!;
  const body = fm[2]!;
  const close = fm[3]!;
  if (!STATUS_LINE.test(body)) return undefined;

  // Keep any trailing inline comment ($3); swap only the value ($2).
  const newBody = body.replace(
    STATUS_LINE,
    (_m, key, _value, comment) => `${key}${status}${comment}`,
  );
  const newBlock = `${open}${newBody}${close}`;
  return content.slice(0, fm.index) + newBlock + content.slice(fm.index + block.length);
}
