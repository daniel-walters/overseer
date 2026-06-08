import React, { useReducer, useState } from "react";
import { useApp, useInput } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { navReduce, initialNav } from "./navigation.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";

/**
 * The dispatch seams the App drives, injected so the keypress → preview →
 * confirm flow is testable without filesystem reads or real agents.
 *
 * - `readFrontier` reads the selected PRD's dispatch view and computes its
 *   frontier for the preview (and, on confirm, the flip+spawn to act on).
 * - `dispatch` runs the dispatch over that frontier (flip each spawn candidate
 *   to in-progress, then spawn it).
 */
export interface Dispatcher {
  readonly readFrontier: (prdId: string) => readonly FrontierEntry[];
  readonly dispatch: (frontier: readonly FrontierEntry[]) => void;
}

interface AppProps {
  board: Board;
  /** Wired in production; absent in tests that don't exercise dispatch. */
  dispatcher?: Dispatcher;
}

/**
 * The root Ink component. It owns UI state (selection + zoom level + the modal
 * dispatch preview) via the navigation reducer, kept separate from `board` so a
 * live re-scan never clobbers the user's place. Keys drive the reducer; `q`
 * quits, backing out of a zoom first; `d` (board level) opens the dispatch
 * preview, Enter/`y` confirms, `Esc` cancels.
 */
export function App({ board, dispatcher }: AppProps) {
  const { exit } = useApp();
  const [nav, dispatch] = useReducer(navReduce, initialNav);
  // The frontier captured when the preview opened — what the preview renders and
  // what a confirm dispatches. Held outside the reducer (it's data, not nav).
  const [frontier, setFrontier] = useState<readonly FrontierEntry[]>([]);

  // Clamp the stored selection against the current board so a shrunk board
  // (after a live refresh) can never leave us pointing past the last card.
  const boardIndex = Math.min(nav.boardIndex, Math.max(0, board.prds.length - 1));
  const selectedPrd = board.prds[boardIndex];
  const issues = selectedPrd?.issues ?? [];
  const issueIndex = Math.min(nav.issueIndex, Math.max(0, issues.length - 1));

  useInput((input, key) => {
    // The modal preview owns input while it is open: only confirm/cancel apply.
    if (nav.confirming) {
      if (key.return || input === "y") {
        dispatcher?.dispatch(frontier);
        dispatch({ type: "confirm" });
      } else if (key.escape) {
        dispatch({ type: "cancel" });
      }
      return;
    }

    if (input === "d") {
      if (nav.level === "board" && dispatcher && selectedPrd) {
        setFrontier(dispatcher.readFrontier(selectedPrd.id));
        dispatch({ type: "open-preview" });
      }
      return;
    }

    if (input === "q") {
      if (nav.level === "issues") dispatch({ type: "back" });
      else exit();
      return;
    }

    if (key.return) {
      dispatch({ type: "zoom", issueCount: issues.length });
      return;
    }

    if (key.escape) {
      dispatch({ type: "back" });
      return;
    }

    const delta = moveDelta(input, key);
    if (delta !== 0) {
      const count = nav.level === "board" ? board.prds.length : issues.length;
      dispatch({ type: "move", delta, count });
    }
  });

  if (nav.confirming && selectedPrd) {
    return <DispatchPreview prdTitle={selectedPrd.title} frontier={frontier} />;
  }
  if (nav.level === "issues" && selectedPrd) {
    return <IssueBoard prd={selectedPrd} selectedIndex={issueIndex} />;
  }
  return <BoardView board={board} selectedIndex={boardIndex} />;
}

/** Translate a keypress into a selection delta: -1 (up), +1 (down), or 0. */
function moveDelta(input: string, key: { upArrow: boolean; downArrow: boolean }): number {
  if (key.upArrow || input === "k") return -1;
  if (key.downArrow || input === "j") return 1;
  // Treat horizontal moves the same as vertical: one step through the cards.
  if (input === "h") return -1;
  if (input === "l") return 1;
  return 0;
}
