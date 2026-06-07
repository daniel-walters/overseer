import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Board, PRD, Lane, ReadyFor } from "./model.js";

/**
 * Scan the root directory into an immutable {@link Board}.
 *
 * A pure path → Board function: the single most important seam in Overseer.
 * It performs no watching, no rendering, and never writes — it only reads.
 *
 * Each subdirectory of `root` that contains a `prd.md` is a PRD; a directory
 * without one is silently ignored.
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

  return readyFor === undefined
    ? { id: dirName, title, lane }
    : { id: dirName, title, lane, readyFor };
}

/**
 * Map an authored status string to its lane and, while ready, its routing
 * badge. Unknown or missing status ⇒ the "unsorted" lane (never dropped).
 */
function placeStatus(status: unknown): { lane: Lane; readyFor?: ReadyFor } {
  switch (status) {
    case "backlog":
    case "in-progress":
    case "in-review":
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
