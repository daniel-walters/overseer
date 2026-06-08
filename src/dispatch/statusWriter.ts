import { readFileSync, writeFileSync } from "node:fs";
import matter from "gray-matter";

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
  writeFileSync(path, matter.stringify(parsed.content, { ...parsed.data, status }));
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
