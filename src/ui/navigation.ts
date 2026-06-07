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
}

/** Fresh state: board level, first card selected. */
export const initialNav: NavState = {
  level: "board",
  boardIndex: 0,
  issueIndex: 0,
};

export type NavAction =
  /** Move selection by `delta` within a list of `count` cards (clamped). */
  | { readonly type: "move"; readonly delta: number; readonly count: number }
  /** Zoom into the selected PRD, which has `issueCount` Issues. */
  | { readonly type: "zoom"; readonly issueCount: number }
  /** Back out one level (Issues → board). A no-op at the board level. */
  | { readonly type: "back" };

/** Clamp `n` into `[0, count - 1]`; an empty list pins the index at 0. */
function clamp(n: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(n, count - 1));
}

export function navReduce(state: NavState, action: NavAction): NavState {
  switch (action.type) {
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
