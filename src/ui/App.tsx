import React, { useReducer } from "react";
import { useApp, useInput } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { navReduce, initialNav } from "./navigation.js";
import type { Board } from "../model.js";

interface AppProps {
  board: Board;
}

/**
 * The root Ink component. It owns UI state (selection + zoom level) via the
 * navigation reducer, kept separate from `board` so a live re-scan never
 * clobbers the user's place. Keys drive the reducer; `q` quits, backing out of
 * a zoom first.
 */
export function App({ board }: AppProps) {
  const { exit } = useApp();
  const [nav, dispatch] = useReducer(navReduce, initialNav);

  // Clamp the stored selection against the current board so a shrunk board
  // (after a live refresh) can never leave us pointing past the last card.
  const boardIndex = Math.min(nav.boardIndex, Math.max(0, board.prds.length - 1));
  const selectedPrd = board.prds[boardIndex];
  const issues = selectedPrd?.issues ?? [];
  const issueIndex = Math.min(nav.issueIndex, Math.max(0, issues.length - 1));

  useInput((input, key) => {
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
