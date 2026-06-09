import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Board, PRD, Issue, Lane, ReadyFor } from "./model.js";

/**
 * Scan the root directory into an immutable {@link Board}.
 *
 * A pure path → Board function: the single most important seam in Overseer.
 * It performs no watching, no rendering, and never writes — it only reads.
 *
 * Each subdirectory of `root` that contains a `prd.md` is a PRD; a directory
 * without one is silently ignored. Every other markdown file in a PRD
 * directory is one of that PRD's Issues.
 */
export function scanBoard(root: string): Board {
  const entries = readdirSync(root, { withFileTypes: true });

  const prds: PRD[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const prd = scanPrd(dir, entry.name);
    if (prd) prds.push(prd);
  }

  return { prds };
}

/** Parse one candidate directory into a PRD, or return null if it has no prd.md. */
function scanPrd(dir: string, dirName: string): PRD | null {
  const prdPath = join(dir, "prd.md");

  let raw: string;
  try {
    raw = readFileSync(prdPath, "utf8");
  } catch {
    return null; // no prd.md ⇒ not a PRD
  }

  const { data } = matter(raw);
  const title = typeof data.title === "string" ? data.title : dirName;
  const { lane, readyFor } = placeStatus(data.status);
  const issues = scanIssues(dir);

  return readyFor === undefined
    ? { id: dirName, title, lane, issues }
    : { id: dirName, title, lane, readyFor, issues };
}

/**
 * Parse every markdown file in a PRD directory other than `prd.md` into an
 * Issue, ordered by the `NNN-` filename prefix (filename-alpha) so within-lane
 * order is controlled by deliberate file naming.
 */
function scanIssues(dir: string): Issue[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  return files.map((name) => scanIssue(join(dir, name), name));
}

/** Parse one Issue file. Identity is the filename; title falls back to the slug. */
function scanIssue(path: string, fileName: string): Issue {
  const { data } = matter(readFileSync(path, "utf8"));
  const title =
    typeof data.title === "string" ? data.title : slugFromFileName(fileName);
  const { lane, readyFor } = placeStatus(data.status);

  return readyFor === undefined
    ? { id: fileName, title, lane }
    : { id: fileName, title, lane, readyFor };
}

/**
 * The display fallback for an Issue with no `title`: the filename with its
 * `NNN-` sort prefix and `.md` extension stripped (`007-session-tokens.md`
 * ⇒ `session-tokens`).
 */
function slugFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/, "").replace(/^\d+-/, "");
}

/**
 * Map an authored status string to its lane and, while ready, its routing
 * badge. Unknown or missing status ⇒ the "unsorted" lane (never dropped).
 */
function placeStatus(status: unknown): { lane: Lane; readyFor?: ReadyFor } {
  switch (status) {
    case "backlog":
    case "in-progress":
    case "ready-for-review":
    case "in-review":
    case "human-review":
    case "done":
      return { lane: status };
    case "ready-for-human":
      return { lane: "ready", readyFor: "human" };
    case "ready-for-agent":
      return { lane: "ready", readyFor: "agent" };
    default:
      return { lane: "unsorted" };
  }
}
