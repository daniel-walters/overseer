import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD, readString, readPresentString, safeMatter } from "./issueFile.js";
import {
  HUMAN_REVIEW_REASONS,
  placeStatus,
  derivePrdLane,
  derivePrdNeedsReview,
  type Board,
  type PRD,
  type Issue,
  type Lane,
  type ReadyFor,
  type HumanReviewReason,
  type Liveness,
  type LinkedPr,
} from "./model.js";
import type { Absence } from "./dispatch/liveness.js";
import type { FailedEdgeKind } from "./dispatch/failureLog.js";

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
 * Ask whether one Issue's spawn launch — or its clean merge — failed this session,
 * keyed by its absolute path *and* the edge the lane implies (`ready-for-agent →
 * implementor`, `ready-for-review → reviewer`, `in-review → resolve`) — the
 * read-only projection over the shared failed-set (`suppressedSeam`). `true` lands
 * the `⊘ suppressed` marker on the card. The board can observe suppression through
 * this seam but can never record into the set (PRD: suppressed-card marker, ADR
 * 0011).
 *
 * Mirrors {@link LivenessLookup} as a second optional overlay. It gates the two
 * awaiting `ready-*` lanes (a failed *spawn*) plus the `in-review` lane (a failed
 * clean *merge* on the non-spawn resolve edge — ADR 0019), so unlike liveness it is
 * not disjoint from the active lanes: an `in-review` card can carry both a liveness
 * verdict and a resolve suppression, with the suppressed marker outranking it on the
 * card (the {@link import("./model.js").Issue} precedence). Total by construction —
 * an absent or empty set answers `false` for every pair and never throws out of the
 * board rebuild.
 */
export type SuppressedLookup = (path: string, edge: FailedEdgeKind) => boolean;

/**
 * The review-pass overlay lookup (the Reviewer Iteration Count PRD, ADR 0018):
 * the currently-running AI-review pass Overseer recorded for one Issue, keyed by
 * its absolute path — the same `prdDir/filename` key the sidecar records (ADR
 * 0008), the same key {@link LivenessLookup} uses. `undefined` when no pass is
 * recorded (the spawn/record gap, a legacy entry, or simply not under review) —
 * **absent ≠ `0`**, so the card never renders a false `0/cap` from a default.
 *
 * The third Issue-level overlay lookup, mirroring {@link LivenessLookup} and
 * {@link SuppressedLookup}. Recomputed and passed in on each rebuild, never read
 * from the Issue files (ADR 0002). The scanner consults it **only for a *live*
 * `in-review` Issue** — the count is the healthy in-progress signal, so an
 * orphaned (dead) agent's card shows the Orphan marker instead and an off-lane
 * card carries no count. Total by construction — an empty sidecar answers
 * `undefined` for every path and never throws out of the board rebuild.
 */
export type ReviewPassLookup = (path: string) => number | undefined;

/**
 * The Linked PR overlay lookup ({@link LinkedPr}), keyed by a PRD's absolute
 * directory path. `undefined` when the PRD has no PR (no marker), and the only
 * value it ever returns is for a PR that is open or merged. The scanner consults
 * it **only for `done` PRDs** — the sole PRDs with a feature-branch PR to surface
 * (ADR 0013), which also bounds the per-scan `gh` query to finished work — so a
 * non-`done` PRD is never even passed to it.
 *
 * The PRD-level sibling of {@link LivenessLookup} / {@link SuppressedLookup} (both
 * Issue-level): recomputed and passed in on each rebuild, never read from the PRD
 * files (ADR 0002 / 0003). Omitting it (the eager first render, board-only tests)
 * leaves every PRD's `linkedPr` unset. Total by construction — a `gh` failure
 * resolves to `undefined` (no marker), never out of the scan.
 */
export type LinkedPrLookup = (prdDir: string) => LinkedPr | undefined;

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
 * *not* started on. Positional params rather than an `overlays` bag because each
 * gates a disjoint slice of the board; the same omit-it-and-cards-are-blank
 * contract holds for all of them. Because the two Issue-level lanes are disjoint,
 * no Issue can carry both the liveness and the suppressed overlay.
 *
 * `lookupPr` is the PRD-level Linked PR overlay (ADR 0013), the board's third
 * derived overlay — joined onto a PRD (not an Issue) and consulted only for a
 * `done` PRD, so a `gh` query fires solely for finished work. Like the other two
 * it is recomputed each rebuild and never read from disk; omitting it leaves every
 * PRD's `linkedPr` unset.
 *
 * `lookupReviewPass` is the Issue-level review-pass overlay (ADR 0018), consulted
 * only for an Issue the liveness gate already resolved to a *live* `in-review`
 * card: it joins the sidecar's recorded pass onto the Issue as the `N/cap` marker's
 * numerator. Gated to live-and-in-review so an orphaned agent's card keeps its
 * Orphan marker and an off-lane card carries no count. Recomputed each rebuild and
 * never read from disk; omitting it leaves every Issue's `reviewPass` unset.
 */
export function scanBoard(
  root: string,
  lookupLiveness?: LivenessLookup,
  lookupSuppressed?: SuppressedLookup,
  lookupPr?: LinkedPrLookup,
  lookupReviewPass?: ReviewPassLookup,
): Board {
  const entries = readdirSync(root, { withFileTypes: true });

  const prds: PRD[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const prd = scanPrd(
      dir,
      entry.name,
      lookupLiveness,
      lookupSuppressed,
      lookupPr,
      lookupReviewPass,
    );
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
  lookupPr?: LinkedPrLookup,
  lookupReviewPass?: ReviewPassLookup,
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
  const issues = scanIssues(dir, lookupLiveness, lookupSuppressed, lookupReviewPass);
  // A PRD carries no stored status (ADR 0003); its lane is derived from its
  // Issues, collapsing to backlog / in-progress / done.
  const lane = derivePrdLane(issues);

  // The needs-review overlay is the board's first Issue→PRD roll-up: `true` when
  // ≥1 Issue is parked in `human-review` (derivePrdNeedsReview). Derived from the
  // same Issues, never read from or written to `prd.md` (ADR 0002 / 0003), so a
  // resolved escalation clears it on the next scan. Only `true` stamps the field —
  // a PRD with nothing in human-review stays unmarked (no `needsReview: false`
  // noise), mirroring the other overlays. It is disjoint from the `done`-only
  // Linked PR marker (needs-review implies the PRD is not yet `done`).
  const base: PRD = { id: dirName, title, lane, issues };
  const prd: PRD = derivePrdNeedsReview(issues)
    ? { ...base, needsReview: true }
    : base;
  // The Linked PR overlay rides only on a `done` PRD, keyed by its absolute dir
  // path (ADR 0013). The `done` gate both scopes the marker to PRDs that can have
  // a feature-branch PR and bounds the per-scan `gh` query to finished work — a
  // non-`done` PRD never reaches the lookup. A PR (open/merged) stamps the field;
  // no PR (or no lookup) leaves it unset. The overlay never touches `lane`, so a
  // PR can't promote or demote the PRD (ADR 0003).
  if (lookupPr && lane === "done") {
    const linkedPr = lookupPr(dir);
    if (linkedPr) return { ...prd, linkedPr };
  }
  return prd;
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
  lookupReviewPass?: ReviewPassLookup,
): Issue[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "prd.md")
    .map((e) => e.name)
    .sort();

  return files.map((name) =>
    scanIssue(join(dir, name), name, lookupLiveness, lookupSuppressed, lookupReviewPass),
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
  lookupReviewPass?: ReviewPassLookup,
): Issue {
  const { data } = safeMatter(readFileSync(path, "utf8"));
  const title = readString(data, FIELD.title) ?? slugFromFileName(fileName);
  const { lane, readyFor, malformedStatus } = placeOrBacklog(data[FIELD.status]);

  const issue: Issue = malformedStatus
    ? { id: fileName, title, lane, malformedStatus }
    : { id: fileName, title, lane };
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

  // The suppressed overlay rides the two awaiting `ready-*` lanes (a failed spawn)
  // plus the `in-review` lane (a failed clean merge on the resolve edge — ADR
  // 0019), with the edge derived from the same placement. On `in-review` it is NOT
  // disjoint from the liveness verdict computed above — a held merge can sit on a
  // card whose dead reviewer also reads `orphaned` — so the Card resolves the
  // overlap by precedence: the suppressed marker outranks liveness (and the N/cap
  // count below).
  const withSuppressed = applySuppressed(
    withLiveness,
    path,
    lane,
    readyFor,
    lookupSuppressed,
  );

  // The review-pass overlay rides only on a *live* `in-review` card (ADR 0018) —
  // the healthy in-progress signal — reusing the liveness verdict just computed
  // rather than re-probing: an orphaned or unknown in-review agent keeps its
  // liveness marker and shows no count, and an off-lane card is never even
  // consulted. Applied after liveness because it gates on that verdict; an
  // `in-review` card is never `human-review`, so the count survives the branch
  // below untouched.
  const withReviewPass = applyReviewPass(withSuppressed, path, lane, lookupReviewPass);

  if (lane !== "human-review") return withReviewPass;
  // The escalation reason (an enum, drives the card marker) and the free-text
  // note (the reviewer's "why", surfaced in the detail view) are parsed
  // independently: each only lands on a human-review card, each treats an
  // absent/blank value as absent, and the note is additive — present or not
  // regardless of which reason the card carries.
  const humanReviewReason = parseHumanReviewReason(data[FIELD.humanReviewReason]);
  const humanReviewNote = readPresentString(data, FIELD.humanReviewNote);
  const withReason =
    humanReviewReason === undefined
      ? withSuppressed
      : { ...withSuppressed, humanReviewReason };
  return humanReviewNote === undefined
    ? withReason
    : { ...withReason, humanReviewNote };
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
 * A card outside the two active-agent lanes (ready, done, backlog) — or any
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
 * Add the review-pass count to an Issue, but only on a **live `in-review`** card
 * (the Reviewer Iteration Count PRD, ADR 0018) — the read side of the count the
 * Reactor writes per spawn, surfaced as the `N/cap` marker's numerator.
 *
 * The gate is the crux. The count is the *healthy in-progress* signal, so it rides
 * exactly the card a live reviewer owns and nowhere else:
 *
 * - **Lane `in-review`** — the one lane an AI-review pass runs in. An off-lane card
 *   (still `ready-for-review`, converged to `done`, escalated to `human-review`) is
 *   returned unchanged: it left the in-review lane, so it carries no count.
 * - **Liveness `live`** — reuses the verdict {@link applyLiveness} just stamped
 *   rather than re-probing. An **orphaned** in-review card (its agent died
 *   mid-loop) keeps its loud Orphan marker and shows *no* count — a dead agent is
 *   not "on pass N" of anything — and an **unknown** card stays countless too.
 * - **A recorded pass** — a missing pass (`undefined`: the spawn/record gap, a
 *   legacy entry) leaves the field unset, never a false `0/cap`: absent ≠ `0`.
 *
 * Any card failing a gate — or any card when no lookup is wired in — is returned
 * unchanged. Because the gate requires the live verdict, the count can never
 * co-render with the Orphan/unknown liveness marker on one card.
 */
function applyReviewPass(
  issue: Issue,
  path: string,
  lane: Lane,
  lookupReviewPass?: ReviewPassLookup,
): Issue {
  if (!lookupReviewPass || lane !== "in-review" || issue.liveness !== "live") {
    return issue;
  }
  const reviewPass = lookupReviewPass(path);
  return reviewPass === undefined ? issue : { ...issue, reviewPass };
}

/**
 * Add the suppressed overlay to an Issue on an awaiting `ready-for-agent` /
 * `ready-for-review` card (a failed *spawn*) or an `in-review` card (a failed clean
 * *merge* on the non-spawn resolve edge — ADR 0019) (PRD: suppressed-card marker,
 * ADR 0011).
 *
 * The edge is read straight off the already-derived `{lane, readyFor}` — the same
 * placement {@link applyLiveness} consumes — not re-parsed from the raw status:
 * `ready-for-agent → implementor` is the one card on the `ready` lane carrying the
 * `agent` badge (a `ready-for-human` card shares the lane but carries `human`, so
 * launches nothing), `ready-for-review → reviewer` is its own dedicated lane, and
 * `in-review → resolve` is the verdict frontier Overseer merges. Any other lane has
 * no suppressible edge and is returned unchanged. Deriving from the validated
 * placement (rather than indexing a status string) means a frontmatter value that
 * collides with an `Object.prototype` name can never reach the lookup —
 * `placeStatus` already folded it into `backlog` (flagged `malformedStatus`), a
 * non-suppressible lane. The marker stays edge-agnostic on the card — the column
 * already implies the edge.
 *
 * Lane-gating here is what makes a lingering failed-set entry inert: an Issue that
 * has left its suppressible lane (re-triaged, hand-edited, completed) simply isn't
 * on one, so it drops the marker even though its `(path, edge)` entry persists in
 * the append-only set. Only `true` stamps the field; a not-suppressed card stays
 * unmarked (no `suppressed: false` noise).
 *
 * A card on any non-suppressible lane — or any card when no lookup is wired in — is
 * returned unchanged. Unlike liveness, this is *not* gated to a disjoint lane set:
 * an `in-review` card can carry both a liveness verdict (from {@link applyLiveness})
 * and a resolve suppression, and the Card resolves the overlap by precedence
 * (suppressed wins). A failed *resolve* never lands on a `ready-*` card and a failed
 * *spawn* never on an `in-review` card, so the right edge is always asked.
 */
function applySuppressed(
  issue: Issue,
  path: string,
  lane: Lane,
  readyFor: ReadyFor | undefined,
  lookupSuppressed?: SuppressedLookup,
): Issue {
  if (!lookupSuppressed) return issue;
  const edge = suppressedEdgeForLane(lane, readyFor);
  if (edge === undefined) return issue;
  return lookupSuppressed(path, edge) ? { ...issue, suppressed: true } : issue;
}

/**
 * The failed-set edge a lane implies, or `undefined` if the lane carries no
 * suppressible edge. Reads the derived placement, so the three suppressible lanes
 * map to their edge — the two spawn edges plus the non-spawn `resolve` edge (ADR
 * 0019) — and every other lane (including a `ready-for-human` card, which shares
 * the `ready` lane but launches no agent) yields no edge.
 */
function suppressedEdgeForLane(
  lane: Lane,
  readyFor: ReadyFor | undefined,
): FailedEdgeKind | undefined {
  if (lane === "ready" && readyFor === "agent") return "implementor";
  if (lane === "ready-for-review") return "reviewer";
  if (lane === "in-review") return "resolve";
  return undefined;
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
 * folds into the **backlog** lane carrying `malformedStatus: true` rather than
 * being dropped. The fold keeps PRD-status derivation unchanged — backlog is
 * pre-in-progress and not `done`, exactly as the retired `unsorted` lane was —
 * while the flag drives the card's loud warning marker so the data error is
 * still triaged, not silently parked as ordinary backlog.
 */
function placeOrBacklog(
  status: unknown,
): { lane: Lane; readyFor?: ReadyFor; malformedStatus?: boolean } {
  return placeStatus(status) ?? { lane: "backlog", malformedStatus: true };
}
