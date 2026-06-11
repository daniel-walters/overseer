import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD, readString, safeMatter } from "./issueFile.js";
import {
  HUMAN_REVIEW_REASONS,
  placeStatus,
  derivePrdLane,
  type Board,
  type PRD,
  type Issue,
  type Lane,
  type ReadyFor,
  type HumanReviewReason,
  type Liveness,
} from "./model.js";

/**
 * Look up the liveness verdict for one Issue by its absolute path — the same
 * `prdDir/filename` key the agent sidecar records at spawn time (ADR 0008).
 * `undefined` when the Issue has no recorded handle (a previous session, the
 * spawn/record gap, or simply never dispatched). On an active-agent card the
 * scanner reads that `undefined` as **`unknown`** (the honesty boundary, slice
 * 3): a present-this-session "live" is the only path to a `live` marker.
 */
export type LivenessLookup = (issuePath: string) => Liveness | undefined;

/**
 * Scan the root directory into an immutable {@link Board}.
 *
 * A pure path → Board function: the single most important seam in Overseer.
 * It performs no watching, no rendering, and never writes — it only reads.
 *
 * Each subdirectory of `root` that contains a `prd.md` is a PRD; a directory
 * without one is silently ignored. Every other markdown file in a PRD
 * directory is one of that PRD's Issues.
 *
 * `lookupLiveness` is the optional liveness overlay (ADR 0008), recomputed and
 * passed in on each board rebuild — never read from the Issue files (ADR 0002).
 * It is consulted only for `in-progress` / `in-review` Issues (the two lanes a
 * spawned agent owns); every other lane scans with no liveness. Omitting it (the
 * eager first render, board-only tests) simply leaves every card unmarked.
 */
export function scanBoard(root: string, lookupLiveness?: LivenessLookup): Board {
  const entries = readdirSync(root, { withFileTypes: true });

  const prds: PRD[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const prd = scanPrd(dir, entry.name, lookupLiveness);
    if (prd) prds.push(prd);
  }

  return { prds };
}

/** Parse one candidate directory into a PRD, or return null if it has no prd.md. */
function scanPrd(
  dir: string,
  dirName: string,
  lookupLiveness?: LivenessLookup,
): PRD | null {
  const prdPath = join(dir, "prd.md");

  let raw: string;
  try {
    raw = readFileSync(prdPath, "utf8");
  } catch {
    return null; // no prd.md ⇒ not a PRD
  }

  const { data } = safeMatter(raw);
  const title = readString(data, FIELD.title) ?? dirName;
  const issues = scanIssues(dir, lookupLiveness);
  // A PRD carries no stored status (ADR 0003); its lane is derived from its
  // Issues, collapsing to backlog / in-progress / done.
  const lane = derivePrdLane(issues);

  return { id: dirName, title, lane, issues };
}

/**
 * Parse every markdown file in a PRD directory other than `prd.md` into an
 * Issue, ordered by the `NNN-` filename prefix (filename-alpha) so within-lane
 * order is controlled by deliberate file naming.
 */
function scanIssues(dir: string, lookupLiveness?: LivenessLookup): Issue[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  return files.map((name) => scanIssue(join(dir, name), name, lookupLiveness));
}

/** The two lanes an active spawned agent owns, where a liveness marker belongs. */
const LIVENESS_LANES: ReadonlySet<Lane> = new Set<Lane>(["in-progress", "in-review"]);

/** Parse one Issue file. Identity is the filename; title falls back to the slug. */
function scanIssue(
  path: string,
  fileName: string,
  lookupLiveness?: LivenessLookup,
): Issue {
  const { data } = safeMatter(readFileSync(path, "utf8"));
  const title = readString(data, FIELD.title) ?? slugFromFileName(fileName);
  const { lane, readyFor } = placeOrUnsorted(data[FIELD.status]);

  const issue: Issue = { id: fileName, title, lane };
  // A routing badge belongs only on a ready card; an escalation reason only on a
  // human-review card. Each rides its own lane so a stale value can't leak onto
  // a card that has moved on.
  const withReadyFor: Issue =
    readyFor === undefined ? issue : { ...issue, readyFor };

  // The liveness overlay rides only on the two active-agent lanes (in-progress,
  // in-review), keyed by the Issue's absolute path — the sidecar's join key
  // (ADR 0008). Once a lookup is wired in, such a card always carries a verdict:
  // the lookup's "live"/"unknown" when it has one, and a default of "unknown"
  // when it has none — the honesty boundary (slice 3) below.
  const withLiveness = applyLiveness(withReadyFor, path, lane, lookupLiveness);

  if (lane !== "human-review") return withLiveness;
  const humanReviewReason = parseHumanReviewReason(data[FIELD.humanReviewReason]);
  return humanReviewReason === undefined
    ? withLiveness
    : { ...withLiveness, humanReviewReason };
}

/**
 * Add the liveness verdict to an Issue, but only on an `in-progress` / `in-review`
 * card. This is the honesty boundary (ADR 0008, slice 3): once a lookup is
 * provided, every active-agent card *must* carry a verdict — silence on an
 * in-progress card is the very ambiguity the feature exists to kill.
 *
 * So the lookup's verdict is used when it has one, and **`unknown`** is the
 * default when it has none (the never-recorded cases: a previous session, an
 * empty sidecar, or the spawn/record gap). The only path to **`live`** is the
 * lookup positively returning it for a handle recorded *this* session — every
 * other case, ambiguous or not, reads `unknown`, never a false `live`.
 *
 * A card outside the two active-agent lanes (ready, done, unsorted) — or any
 * card when no lookup is wired in — is returned unchanged and stays unmarked:
 * no agent owns it, so it has no liveness to report.
 */
function applyLiveness(
  issue: Issue,
  path: string,
  lane: Lane,
  lookupLiveness?: LivenessLookup,
): Issue {
  if (!lookupLiveness || !LIVENESS_LANES.has(lane)) return issue;
  return { ...issue, liveness: lookupLiveness(path) ?? "unknown" };
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
