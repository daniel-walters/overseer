import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD, readString, safeMatter } from "./issueFile.js";
import {
  HUMAN_REVIEW_REASONS,
  SUPPRESSED_EDGE_BY_STATUS,
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
import type { Absence } from "./dispatch/liveness.js";
import type { SpawnEdgeKind } from "./dispatch/failureLog.js";

/**
 * Look up the probe's trust-qualified absence ({@link Absence}) for one Issue by
 * its absolute path — the same `prdDir/filename` key the agent sidecar records at
 * spawn time (ADR 0008). `undefined` when the Issue has no recorded handle (a
 * previous session, the spawn/record gap, or simply never dispatched). On an
 * active-agent card the scanner reads that `undefined` as **`unknown`** (the
 * honesty boundary): a present-this-session match is the only path to `live`, and
 * a *trustworthy* absence (`absent-clean`) the only path to `orphaned` (ADR 0009).
 */
export type LivenessLookup = (issuePath: string) => Absence | undefined;

/**
 * Ask whether one Issue's spawn launch failed this session, keyed by its absolute
 * path *and* the spawn edge the lane implies (`ready-for-agent → implementor`,
 * `ready-for-review → reviewer`) — the read-only projection over the shared
 * failed-set (`suppressedSeam`). `true` lands the `⊘ suppressed` marker on the
 * card. The board can observe suppression through this seam but can never record
 * into the set (PRD: suppressed-card marker, ADR 0011).
 *
 * Mirrors {@link LivenessLookup} as a second optional overlay, gated to the
 * opposite (awaiting) lanes. Total by construction — an absent or empty set
 * answers `false` for every pair and never throws out of the board rebuild.
 */
export type SuppressedLookup = (path: string, edge: SpawnEdgeKind) => boolean;

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
 *
 * `lookupSuppressed` is the mirror-image optional overlay, gated to the opposite
 * (awaiting) `ready-for-agent` / `ready-for-review` lanes — the two an agent has
 * *not* started on. A second param rather than an `overlays` bag because there are
 * exactly two and they gate disjoint lanes; the same omit-it-and-cards-are-blank
 * contract holds. Because the lanes are disjoint, no Issue can carry both overlays.
 */
export function scanBoard(
  root: string,
  lookupLiveness?: LivenessLookup,
  lookupSuppressed?: SuppressedLookup,
): Board {
  const entries = readdirSync(root, { withFileTypes: true });

  const prds: PRD[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const prd = scanPrd(dir, entry.name, lookupLiveness, lookupSuppressed);
    if (prd) prds.push(prd);
  }

  return { prds };
}

/** Parse one candidate directory into a PRD, or return null if it has no prd.md. */
function scanPrd(
  dir: string,
  dirName: string,
  lookupLiveness?: LivenessLookup,
  lookupSuppressed?: SuppressedLookup,
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
  const issues = scanIssues(dir, lookupLiveness, lookupSuppressed);
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
function scanIssues(
  dir: string,
  lookupLiveness?: LivenessLookup,
  lookupSuppressed?: SuppressedLookup,
): Issue[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  return files.map((name) =>
    scanIssue(join(dir, name), name, lookupLiveness, lookupSuppressed),
  );
}

/** The two lanes an active spawned agent owns, where a liveness marker belongs. */
const LIVENESS_LANES: ReadonlySet<Lane> = new Set<Lane>(["in-progress", "in-review"]);

/** Parse one Issue file. Identity is the filename; title falls back to the slug. */
function scanIssue(
  path: string,
  fileName: string,
  lookupLiveness?: LivenessLookup,
  lookupSuppressed?: SuppressedLookup,
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
  // the lookup's absence mapped to live/orphaned/unknown, and a default of
  // "unknown" when it has none — the honesty boundary below.
  const withLiveness = applyLiveness(withReadyFor, path, lane, lookupLiveness);

  // The suppressed overlay is the mirror image, gated to the two awaiting
  // `ready-*` lanes (the opposite set from liveness's active lanes), with the
  // edge derived from the authored status. Disjoint lanes guarantee it never
  // co-renders with a liveness verdict on one card.
  const withSuppressed = applySuppressed(
    withLiveness,
    path,
    data[FIELD.status],
    lookupSuppressed,
  );

  if (lane !== "human-review") return withSuppressed;
  const humanReviewReason = parseHumanReviewReason(data[FIELD.humanReviewReason]);
  return humanReviewReason === undefined
    ? withSuppressed
    : { ...withSuppressed, humanReviewReason };
}

/**
 * Add the liveness verdict to an Issue, but only on an `in-progress` / `in-review`
 * card. This is the honesty boundary (ADR 0008 / 0009): once a lookup is
 * provided, every active-agent card *must* carry a verdict — silence on an
 * in-progress card is the very ambiguity the feature exists to kill.
 *
 * The lane gate lives here, not in the probe: the probe emits a status-ignorant
 * trust-qualified {@link Absence}, and this is the one place that knows these two
 * lanes are owned by an active agent (ADR 0009). It maps the absence to the
 * card-level verdict:
 *
 * - `live` → **live** (the handle is in the registry).
 * - `absent-clean` → **orphaned** (a trustworthy query says the agent is gone:
 *   stuck on an active lane, recoverable).
 * - `absent-degraded` → **unknown** (the query couldn't be trusted; a false
 *   `orphaned` would invite a double-spawn, so it degrades to `unknown`).
 * - no recorded handle → **unknown** (a previous session, an empty sidecar, or
 *   the spawn/record gap). Never a false `live`, and never a false `orphaned`.
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
  return { ...issue, liveness: livenessFromAbsence(lookupLiveness(path)) };
}

/**
 * Add the suppressed overlay to an Issue, but only on an awaiting `ready-for-agent`
 * / `ready-for-review` card — the mirror image of {@link applyLiveness}, gated to
 * the opposite (awaiting) lanes (PRD: suppressed-card marker, ADR 0011).
 *
 * The edge is derived from the *authored status*, not the lane: `ready-for-agent`
 * and `ready-for-human` both fold into the single `ready` lane, but only the
 * `-agent` half is a spawn target, so reading the raw status is the only way to
 * tell the suppressed lane apart from a `ready-for-human` card and to pick the
 * right edge (`ready-for-agent → implementor`, `ready-for-review → reviewer`).
 * The marker stays edge-agnostic on the card — the column already implies the edge.
 *
 * Lane-gating here is what makes a lingering failed-set entry inert: an Issue that
 * has left its `ready-*` lane (re-triaged, hand-edited, completed) simply isn't a
 * suppressed-lane status, so it drops the marker even though its `(path, edge)`
 * entry persists in the append-only set. Only `true` stamps the field; a
 * not-suppressed card stays unmarked (no `suppressed: false` noise).
 *
 * A card on any non-suppressed lane — or any card when no lookup is wired in — is
 * returned unchanged. Because the suppressed lanes are disjoint from the liveness
 * lanes, this can never overwrite or co-exist with a `liveness` verdict.
 */
function applySuppressed(
  issue: Issue,
  path: string,
  status: unknown,
  lookupSuppressed?: SuppressedLookup,
): Issue {
  if (!lookupSuppressed || typeof status !== "string") return issue;
  // `Object.hasOwn`, not a bare index: a frontmatter status that collides with an
  // inherited `Object.prototype` name (`toString`, `constructor`, …) would index
  // a truthy function and pass a non-{@link SpawnEdgeKind} into the lookup. The
  // own-key guard gates the lane to a real suppressed status; `Object.hasOwn`
  // doesn't narrow `status` in TS, so the `keyof` cast on the index is still
  // required. The payoff is the explicit `: SpawnEdgeKind` annotation below
  // (rather than an `as SpawnEdgeKind`): it fails to compile if the map ever
  // maps a status to a non-`SpawnEdgeKind` value, which a value cast would not.
  if (!Object.hasOwn(SUPPRESSED_EDGE_BY_STATUS, status)) return issue;
  const edge: SpawnEdgeKind = SUPPRESSED_EDGE_BY_STATUS[
    status as keyof typeof SUPPRESSED_EDGE_BY_STATUS
  ];
  return lookupSuppressed(path, edge) ? { ...issue, suppressed: true } : issue;
}

/**
 * Map the probe's trust-qualified absence onto the card-level verdict (ADR 0009).
 *
 * `undefined` (no recorded handle — a previous session, an empty sidecar, or the
 * spawn/record gap) reads `unknown` up front. Every *named* {@link Absence} is
 * then matched explicitly, with a `never`-checked default: adding a fourth
 * Absence variant (e.g. the planned kill-switch verdict) without a case here is a
 * compile error, not a silent fold into `unknown`, so a real liveness signal can
 * never be misclassified as benign.
 */
function livenessFromAbsence(absence: Absence | undefined): Liveness {
  if (absence === undefined) return "unknown";
  switch (absence) {
    case "live":
      return "live";
    case "absent-clean":
      return "orphaned";
    // An untrusted query ("gone" we can't believe) must never read as a dead
    // agent — a false `orphaned` invites a double-spawn.
    case "absent-degraded":
      return "unknown";
    default: {
      const exhaustive: never = absence;
      return exhaustive;
    }
  }
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
