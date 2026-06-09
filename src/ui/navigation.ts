/**
 * UI navigation state and its transitions, kept as a pure reducer with no Ink
 * or Board dependency. Selection and zoom level live here — separate from the
 * board data — so a live re-scan never clobbers the user's place.
 */

/** Which kanban is on screen: the board (PRDs) or one PRD's Issues. */
export type Level = "board" | "issues";

export interface NavState {
  /** The level currently rendered. */
  readonly level: Level;
  /** Selected PRD index at the board level. */
  readonly boardIndex: number;
  /** Selected Issue index while zoomed into a PRD. */
  readonly issueIndex: number;
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

/** Fresh state: board level, first card selected, no modal open. */
export const initialNav: NavState = {
  level: "board",
  boardIndex: 0,
  issueIndex: 0,
  confirming: false,
};

export type NavAction =
  /** Move selection by `delta` within a list of `count` cards (clamped). */
  | { readonly type: "move"; readonly delta: number; readonly count: number }
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
      if (state.level === "board") {
        return { ...state, boardIndex: clamp(state.boardIndex + action.delta, action.count) };
      }
      return { ...state, issueIndex: clamp(state.issueIndex + action.delta, action.count) };
    }
    case "zoom": {
      if (state.level !== "board") return state;
      return { ...state, level: "issues", issueIndex: clamp(0, action.issueCount) };
    }
    case "back": {
      if (state.level !== "issues") return state;
      return { ...state, level: "board" };
    }
  }
}
