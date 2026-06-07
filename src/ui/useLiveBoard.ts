import { useEffect, useState } from "react";
import type { Board } from "../model.js";

export interface UseLiveBoardOptions {
  /** The configured root being watched. */
  readonly root: string;
  /** The board from the eager first scan, rendered before any change fires. */
  readonly initialBoard: Board;
  /** Re-scan the root into a fresh Board (defaults wired in cli.tsx). */
  readonly scan: (root: string) => Board;
  /** Watch the root, calling back on each debounced change; returns teardown. */
  readonly watch: (root: string, onChange: () => void) => () => void;
}

/**
 * Hold the live board: start from the eager first scan, then re-scan and
 * re-render on every debounced filesystem change, tearing the watcher down on
 * unmount. The board is the only thing that changes here — UI state (selection,
 * zoom) lives in the navigation reducer, so a refresh never clobbers the user's
 * place.
 */
export function useLiveBoard({
  root,
  initialBoard,
  scan,
  watch,
}: UseLiveBoardOptions): Board {
  const [board, setBoard] = useState(initialBoard);

  useEffect(() => {
    const teardown = watch(root, () => setBoard(scan(root)));
    return teardown;
  }, [root, scan, watch]);

  return board;
}
