import React from "react";
import { BoardView } from "./Board.js";
import type { Board } from "../model.js";

interface AppProps {
  board: Board;
}

/**
 * The root Ink component. For this slice it is a thin wrapper around the
 * board-level kanban; later slices add zoom, selection, and live refresh while
 * keeping UI state separate from the board data.
 */
export function App({ board }: AppProps) {
  return <BoardView board={board} />;
}
