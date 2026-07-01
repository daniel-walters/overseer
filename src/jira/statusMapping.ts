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
 * Whether two status names refer to the same status, comparing case- and
 * surrounding-whitespace-insensitively. The reconciler uses this to decide the
 * epic is already at its target (an idempotent no-op) rather than firing a
 * needless transition, so a workflow reporting `"in progress"` still matches a
 * configured `"In Progress"`.
 */
export function statusEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
