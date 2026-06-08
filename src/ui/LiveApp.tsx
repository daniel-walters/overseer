import React from "react";
import { App } from "./App.js";
import { useLiveBoard, type UseLiveBoardOptions } from "./useLiveBoard.js";

/**
 * The live root: feed {@link App} a board that re-scans on every debounced
 * filesystem change. App owns UI state (selection, zoom) separately from the
 * board, so a refresh under the user's feet never loses their place.
 */
export function LiveApp(props: UseLiveBoardOptions) {
  const board = useLiveBoard(props);
  return <App board={board} />;
}
