/**
 * UI navigation state and its transitions, kept as a pure reducer with no Ink
 * or Board dependency. Selection and zoom level live here — separate from the
 * board data — so a live re-scan never clobbers the user's place.
 *
 * Selection is a 2-D `(laneIndex, rowIndex)` grid coordinate per level, not a
 * flat index: `h`/`l` change the lane, `j`/`k` change the row, at both the
 * 3-column board level and the 8-column Issue level (ADR 0015). The reducer
 * receives the **lane shape** — the per-lane card counts — as `move` action
 * data, exactly as it received `count` before, so it never imports the Board.
 */

/** Which kanban is on screen: the board (PRDs) or one PRD's Issues. */
export type Level = "board" | "issues";

/** A movement direction, the four `hjkl`/arrow gestures spell out. */
export type MoveDir = "left" | "right" | "up" | "down";

/**
 * A grid selection within one level's lanes.
 *
 * - `laneIndex` — the selected column (an index into the level's lanes).
 * - `rowIndex` — the live selected row within that lane (always rests on a card
 *   once resolved against the lane shape).
 * - `desiredRow` — the *remembered* row, the sticky target a cross-lane move
 *   clamps from. `j`/`k` set it alongside `rowIndex`; `h`/`l` leave it untouched
 *   and re-derive `rowIndex` from it. A tall → short → tall round-trip therefore
 *   lands back on the original row, not the clamped one.
 */
export interface Coord {
  readonly laneIndex: number;
  readonly rowIndex: number;
  readonly desiredRow: number;
}

export interface NavState {
  /** The level currently rendered. */
  readonly level: Level;
  /** The grid selection at the board level (PRDs across the three lanes). */
  readonly board: Coord;
  /** The grid selection while zoomed into a PRD's Issues (eight lanes). */
  readonly issues: Coord;
  /**
   * True while a modal preview is open — either the board-level dispatch preview
   * or the Issue-level review preview. A modal state, not a level: the
   * underlying selection is kept intact so the action targets it, but every
   * normal navigation action is suppressed until the user confirms or cancels —
   * the selection can't drift out from under the dispatch or review. Which
   * preview is open is App-level data, not nav state; the reducer only tracks
   * that a modal owns input.
   */
  readonly confirming: boolean;
}

/** The origin coordinate: first lane, first row. */
const ORIGIN: Coord = { laneIndex: 0, rowIndex: 0, desiredRow: 0 };

/** Fresh state: board level, first lane/row selected, no modal open. */
export const initialNav: NavState = {
  level: "board",
  board: ORIGIN,
  issues: ORIGIN,
  confirming: false,
};

export type NavAction =
  /**
   * Move the selection one step in `dir` across the current level's grid, whose
   * shape is the per-lane card counts in `lanes`. `up`/`down` change the row,
   * `left`/`right` change the lane (skipping empty lanes). The lane shape is
   * plain data, the way `count` was — the reducer never sees the Board.
   */
  | { readonly type: "move"; readonly dir: MoveDir; readonly lanes: readonly number[] }
  /** Zoom into the selected PRD, which has `issueCount` Issues. */
  | { readonly type: "zoom"; readonly issueCount: number }
  /** Back out one level (Issues → board). A no-op at the board level. */
  | { readonly type: "back" }
  /** Open the modal dispatch preview. Board level only; ignored when zoomed. */
  | { readonly type: "open-preview" }
  /** Open the modal review preview. Issue level only; ignored at the board. */
  | { readonly type: "open-review" }
  /** Confirm the dispatch and close the preview. No-op unless confirming. */
  | { readonly type: "confirm" }
  /** Cancel the dispatch and close the preview. No-op unless confirming. */
  | { readonly type: "cancel" };

/** Clamp `n` into `[0, count - 1]`; an empty list pins the index at 0. */
function clamp(n: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(n, count - 1));
}

/**
 * Resolve a stored {@link Coord} against a live lane shape into the concrete
 * `(laneIndex, rowIndex)` of the card it selects, or `undefined` if every lane
 * is empty (no card to rest on).
 *
 * The stored coordinate can fall stale under a live re-scan — its lane may have
 * emptied, or its row run past the now-shorter lane. So this snaps onto the
 * first non-empty lane when the stored one has no cards, and clamps the row to
 * the lane's last card. The renderer maps the result to the card's id; the
 * reducer keeps the *intended* coordinate, this turns it into the *displayed*
 * one — never letting selection rest on nothing while any card exists.
 */
export function selectedCoord(
  coord: Coord,
  lanes: readonly number[],
): { readonly laneIndex: number; readonly rowIndex: number } | undefined {
  const laneIndex = resolveLane(coord.laneIndex, lanes);
  if (laneIndex === -1) return undefined;
  return { laneIndex, rowIndex: clamp(coord.rowIndex, lanes[laneIndex] ?? 0) };
}

/**
 * The lane a stored index actually rests on: itself if it has cards, else the
 * first non-empty lane (or `-1` if every lane is empty). Both the displayed
 * selection and a movement step snap onto this, so movement always operates on
 * the lane the user sees — never on an empty stored lane left behind by a
 * re-scan or the initial origin coordinate.
 */
function resolveLane(laneIndex: number, lanes: readonly number[]): number {
  if ((lanes[laneIndex] ?? 0) > 0) return laneIndex;
  return lanes.findIndex((n) => n > 0);
}

/**
 * Step the lane index toward the next *non-empty* lane in `dir`, skipping empty
 * lanes so selection always lands on a card. Returns the unchanged index when
 * there is no non-empty lane on that side (the edge, or all-empty beyond it).
 */
function nextNonEmptyLane(
  laneIndex: number,
  dir: "left" | "right",
  lanes: readonly number[],
): number {
  const step = dir === "right" ? 1 : -1;
  for (let i = laneIndex + step; i >= 0 && i < lanes.length; i += step) {
    if ((lanes[i] ?? 0) > 0) return i;
  }
  return laneIndex;
}

/** Apply a {@link MoveDir} to a {@link Coord} against the given lane shape. */
function moveCoord(input: Coord, dir: MoveDir, lanes: readonly number[]): Coord {
  // Snap onto the displayed card first: a move starts from where the selection
  // visibly rests, not from a stale stored lane the re-scan or origin left empty.
  // Reuse the input object when the snap is a no-op so a blocked move can return
  // the very same coordinate (the reducer's referential-equality no-op contract).
  const laneIndex0 = resolveLane(input.laneIndex, lanes);
  if (laneIndex0 === -1) return input; // every lane empty — nothing to move to.
  const rowIndex0 = clamp(input.rowIndex, lanes[laneIndex0] ?? 0);
  const coord: Coord =
    laneIndex0 === input.laneIndex && rowIndex0 === input.rowIndex
      ? input
      : { ...input, laneIndex: laneIndex0, rowIndex: rowIndex0 };

  switch (dir) {
    case "up":
    case "down": {
      // Vertical: change the row within the current lane; record it as the new
      // remembered row so a later cross-lane move sticks to it.
      const height = lanes[coord.laneIndex] ?? 0;
      const rowIndex = clamp(coord.rowIndex + (dir === "down" ? 1 : -1), height);
      if (rowIndex === coord.rowIndex && coord.desiredRow === rowIndex) return coord;
      return { ...coord, rowIndex, desiredRow: rowIndex };
    }
    case "left":
    case "right": {
      // Horizontal: move to the next non-empty lane, leaving the remembered row
      // untouched and re-deriving the live row from it against the target lane.
      const laneIndex = nextNonEmptyLane(coord.laneIndex, dir, lanes);
      if (laneIndex === coord.laneIndex) return coord;
      const rowIndex = clamp(coord.desiredRow, lanes[laneIndex] ?? 0);
      return { ...coord, laneIndex, rowIndex };
    }
  }
}

export function navReduce(state: NavState, action: NavAction): NavState {
  // While the modal preview is open, normal navigation is suspended: only the
  // preview's own confirm/cancel get through.
  if (state.confirming && action.type !== "confirm" && action.type !== "cancel") {
    return state;
  }

  switch (action.type) {
    case "open-preview": {
      if (state.level !== "board") return state;
      return { ...state, confirming: true };
    }
    case "open-review": {
      // Review is a deliberate act on one selected Issue, so its preview only
      // opens while zoomed into a PRD's Issues — never at the board level.
      if (state.level !== "issues") return state;
      return { ...state, confirming: true };
    }
    case "confirm":
    case "cancel": {
      if (!state.confirming) return state;
      return { ...state, confirming: false };
    }
    case "move": {
      const key = state.level === "board" ? "board" : "issues";
      const next = moveCoord(state[key], action.dir, action.lanes);
      // A no-op move (clamped at an edge, or every lane to the side empty)
      // returns the same coordinate object — pass the same state through so
      // referential-equality checks (and the modal/test invariants) hold.
      if (next === state[key]) return state;
      return { ...state, [key]: next };
    }
    case "zoom": {
      if (state.level !== "board") return state;
      return { ...state, level: "issues", issues: ORIGIN };
    }
    case "back": {
      if (state.level !== "issues") return state;
      return { ...state, level: "board" };
    }
  }
}
