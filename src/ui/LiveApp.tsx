import React from "react";
import { App, type Dispatcher, type Reviewer } from "./App.js";
import { useLiveBoard, type UseLiveBoardOptions } from "./useLiveBoard.js";

export interface LiveAppProps extends UseLiveBoardOptions {
  /** The dispatch seams, wired in cli.tsx; absent in board-only tests. */
  readonly dispatcher?: Dispatcher;
  /** The review seams, wired in cli.tsx; absent in board-only tests. */
  readonly reviewer?: Reviewer;
}

// `reactor` rides in via UseLiveBoardOptions, consumed by useLiveBoard rather
// than App, so it is not re-declared here.

/**
 * The live root: feed {@link App} a board that re-scans on every debounced
 * filesystem change. App owns UI state (selection, zoom, the dispatch/review
 * preview) separately from the board, so a refresh under the user's feet never
 * loses their place. The dispatcher and reviewer are threaded straight through.
 */
export function LiveApp({ dispatcher, reviewer, ...options }: LiveAppProps) {
  const board = useLiveBoard(options);
  return <App board={board} dispatcher={dispatcher} reviewer={reviewer} />;
}
