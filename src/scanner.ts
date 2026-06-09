import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD, readString, safeMatter } from "./issueFile.js";
import {
  HUMAN_REVIEW_REASONS,
  placeStatus,
  type Board,
  type PRD,
  type Issue,
  type Lane,
  type ReadyFor,
  type HumanReviewReason,
} from "./model.js";

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

  const { data } = safeMatter(raw);
  const title = readString(data, FIELD.title) ?? dirName;
  const { lane, readyFor } = placeOrUnsorted(data[FIELD.status]);
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
  const { data } = safeMatter(readFileSync(path, "utf8"));
  const title = readString(data, FIELD.title) ?? slugFromFileName(fileName);
  const { lane, readyFor } = placeOrUnsorted(data[FIELD.status]);

  const issue: Issue = { id: fileName, title, lane };
  // A routing badge belongs only on a ready card; an escalation reason only on a
  // human-review card. Each rides its own lane so a stale value can't leak onto
  // a card that has moved on.
  const withReadyFor: Issue =
    readyFor === undefined ? issue : { ...issue, readyFor };

  if (lane !== "human-review") return withReadyFor;
  const humanReviewReason = parseHumanReviewReason(data[FIELD.humanReviewReason]);
  return humanReviewReason === undefined
    ? withReadyFor
    : { ...withReadyFor, humanReviewReason };
}

/**
 * Read the `human_review_reason` frontmatter into a {@link HumanReviewReason},
 * or `undefined` when absent or not one of the known reasons. An unrecognized
 * value is dropped rather than surfaced as a junk marker — the card simply shows
 * no reason, the same fail-safe the lane mapping uses for an unknown status.
 */
function parseHumanReviewReason(value: unknown): HumanReviewReason | undefined {
  return HUMAN_REVIEW_REASONS.includes(value as HumanReviewReason)
    ? (value as HumanReviewReason)
    : undefined;
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
 * Place a card by its authored status, applying the scanner's fail-safe: an
 * unknown or missing status (where {@link placeStatus} returns `undefined`)
 * lands the card in the leftmost `unsorted` lane rather than being dropped.
 */
function placeOrUnsorted(status: unknown): { lane: Lane; readyFor?: ReadyFor } {
  return placeStatus(status) ?? { lane: "unsorted" };
}
