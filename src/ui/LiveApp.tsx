import React from "react";
import { App, type Dispatcher } from "./App.js";
import { useLiveBoard, type UseLiveBoardOptions } from "./useLiveBoard.js";

export interface LiveAppProps extends UseLiveBoardOptions {
  /** The dispatch seams, wired in cli.tsx; absent in board-only tests. */
  readonly dispatcher?: Dispatcher;
}

/**
 * The live root: feed {@link App} a board that re-scans on every debounced
 * filesystem change. App owns UI state (selection, zoom, the dispatch preview)
 * separately from the board, so a refresh under the user's feet never loses
 * their place. The dispatcher is threaded straight through to App.
 */
export function LiveApp({ dispatcher, ...options }: LiveAppProps) {
  const board = useLiveBoard(options);
  return <App board={board} dispatcher={dispatcher} />;
}
