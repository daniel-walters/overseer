/**
 * The JIRA mirror's status vocabulary — a pure module (CONTEXT.md → JIRA mirror,
 * ADR 0028). This slice introduces the **PRD-lane → epic-status half**: a PRD's
 * derived board lane (`backlog` / `in-progress` / `done`) mapped to the named
 * JIRA status its mirrored epic should track (`To Do` / `In Progress` / `Done`).
 *
 * The targets are *named* statuses, not JIRA's three status *categories*: the
 * mirror transitions an epic to a status by name, so the mapping must yield the
 * conventional status name (defaulting to `To Do` / `In Progress` / `Done`) with
 * a per-board {@link EpicStatusNames} override for workflows that renamed them.
 *
 * Kept pure and dependency-free so it is exhaustively table-tested (like
 * {@link import("../model.js").placeStatus}): every lane maps to a name, and the
 * *degradation* when a named status is absent from the target workflow lives one
 * layer out in the reconciler (a transition the {@link import("./jiraSeam.js").JiraSeam}
 * rejects is a logged no-op), never here — this module never fails.
 */

/** The three PRD board lanes a PRD's derived status collapses to (ADR 0003). */
export type PrdLane = "backlog" | "in-progress" | "done";

/**
 * The named JIRA statuses an epic is driven to, one per PRD lane. Named (not
 * categories) because the mirror transitions by status name; overridable per the
 * `[jira]` config for a workflow whose statuses are renamed. `inProgress` is
 * camelCased (the lane is `in-progress`) to stay a legal identifier.
 */
export interface EpicStatusNames {
  readonly backlog: string;
  readonly inProgress: string;
  readonly done: string;
}

/**
 * The conventional JIRA status names, used when the `[jira]` config supplies no
 * override. `To Do` / `In Progress` / `Done` are the default names JIRA Cloud's
 * standard workflow ships with.
 */
export const DEFAULT_EPIC_STATUS_NAMES: EpicStatusNames = {
  backlog: "To Do",
  inProgress: "In Progress",
  done: "Done",
};

/**
 * The named JIRA status a PRD's mirrored epic should track, given the PRD's
 * derived board lane. Total over the three lanes; a workflow-specific
 * {@link EpicStatusNames} (from config) overrides the conventional names.
 */
export function epicTargetStatus(
  lane: PrdLane,
  names: EpicStatusNames = DEFAULT_EPIC_STATUS_NAMES,
): string {
  switch (lane) {
    case "backlog":
      return names.backlog;
    case "in-progress":
      return names.inProgress;
    case "done":
      return names.done;
  }
}

/**
 * The named JIRA statuses an Issue's mirrored **child** is driven to — the four
 * buckets the ten authored statuses coarsen to (CONTEXT.md → JIRA mirror, user
 * story 15). A superset of {@link EpicStatusNames} (it adds `inReview`, the
 * status inside the In-Progress *category* that the epic rollup never needs), so
 * one `[jira.status]` override map feeds both halves: a value of this type is
 * structurally assignable wherever an {@link EpicStatusNames} is wanted.
 * `backlog` names the "To Do" status (every not-yet-started authored status lands
 * there); `inReview` names the "In Review" status.
 */
export interface IssueStatusNames extends EpicStatusNames {
  readonly inReview: string;
}

/**
 * The conventional JIRA status names for the four Issue buckets, used when the
 * `[jira]` config supplies no override — the {@link DEFAULT_EPIC_STATUS_NAMES}
 * three plus the standard `In Review` status.
 */
export const DEFAULT_ISSUE_STATUS_NAMES: IssueStatusNames = {
  ...DEFAULT_EPIC_STATUS_NAMES,
  inReview: "In Review",
};

/**
 * Which of the four {@link IssueStatusNames} buckets each authored Issue status
 * maps to. The single source of the Issue-half mapping (CONTEXT.md → JIRA mirror):
 * every not-yet-started status → the `backlog`/"To Do" bucket, the sole active
 * status → `inProgress`, every review-ish status (audit, review, and the folded-in
 * `human-review`) → `inReview`, and `done` → `done`. Kept as data (not a switch)
 * so it stays exhaustively table-testable and a new status is one line.
 */
const ISSUE_STATUS_BUCKET: Readonly<Record<string, keyof IssueStatusNames>> = {
  backlog: "backlog",
  "ready-for-human": "backlog",
  "ready-for-agent": "backlog",
  "in-progress": "inProgress",
  "ready-for-audit": "inReview",
  "in-audit": "inReview",
  "ready-for-review": "inReview",
  "in-review": "inReview",
  "human-review": "inReview",
  done: "done",
};

/**
 * The named JIRA status an Issue's mirrored child should track, given the Issue's
 * authored `status` string, or `undefined` when the status is not one of the ten
 * authored values. A workflow-specific {@link IssueStatusNames} (from config)
 * overrides the conventional names.
 *
 * `undefined` (not a throw, not a wrong bucket) is the fail-safe for an
 * unrecognised/malformed status: the reconciler creates the child regardless but
 * skips its self-heal, exactly as it skips when an epic's current status can't be
 * read — a data error never drives a child to a bogus column. The own-property
 * guard keeps an `Object.prototype` member name (`toString`, `constructor`, …)
 * from reading an inherited value off the lookup and returning a bogus bucket.
 */
export function issueTargetStatus(
  status: string,
  names: IssueStatusNames = DEFAULT_ISSUE_STATUS_NAMES,
): string | undefined {
  if (!Object.hasOwn(ISSUE_STATUS_BUCKET, status)) return undefined;
  return names[ISSUE_STATUS_BUCKET[status]!];
}

/**
 * Whether two status names refer to the same status, comparing case- and
 * surrounding-whitespace-insensitively. The reconciler uses this to decide the
 * epic is already at its target (an idempotent no-op) rather than firing a
 * needless transition, so a workflow reporting `"in progress"` still matches a
 * configured `"In Progress"`.
 */
export function statusEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
