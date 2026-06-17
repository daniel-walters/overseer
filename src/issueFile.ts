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
  blockedBy: "blocked_by",
  humanReviewReason: "human_review_reason",
  humanReviewNote: "human_review_note",
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
