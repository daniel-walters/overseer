import { readFileSync, writeFileSync } from "node:fs";
import matter from "gray-matter";

/**
 * Rewrite a single Issue file's `status` frontmatter in place, preserving the
 * rest of the file: every other frontmatter key and the entire markdown body.
 *
 * This is the dispatcher's one sanctioned mutation of an Issue (see ADR 0002):
 * the synchronous `ready-for-agent → in-progress` flip on dispatch, and the
 * `in-progress → ready-for-agent` rollback when a spawn fails. Because the root
 * is filesystem-watched, the write is also the event that moves the card on the
 * live board.
 */
export function writeStatus(path: string, status: string): void {
  const parsed = matter(readFileSync(path, "utf8"));
  const data = { ...parsed.data, status };
  writeFileSync(path, matter.stringify(parsed.content, data));
}
