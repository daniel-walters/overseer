import React, { useState } from "react";
import { App, type Dispatcher, type Reviewer, type Rollback } from "./App.js";
import { useLiveBoard, type UseLiveBoardOptions } from "./useLiveBoard.js";

export interface LiveAppProps extends UseLiveBoardOptions {
  /** The dispatch seams, wired in cli.tsx; absent in board-only tests. */
  readonly dispatcher?: Dispatcher;
  /** The review seams, wired in cli.tsx; absent in board-only tests. */
  readonly reviewer?: Reviewer;
  /** The orphan-recovery seam, wired in cli.tsx; absent in board-only tests. */
  readonly rollback?: Rollback;
}

// `reactor` rides in via UseLiveBoardOptions, consumed by useLiveBoard rather
// than App, so it is not re-declared here.

/**
 * The live root: feed {@link App} a board that re-scans on every debounced
 * filesystem change. App owns UI state (selection, zoom, the dispatch/review
 * preview) separately from the board, so a refresh under the user's feet never
 * loses their place. The dispatcher and reviewer are threaded straight through.
 */
export function LiveApp({ dispatcher, reviewer, rollback, ...options }: LiveAppProps) {
  const board = useLiveBoard(options);
  // Auto-run state lives here, beside the live loop that owns the Reactor — on by
  // default, in-memory, dies on unmount (ADR 0007). The `a` keybind flips it; the
  // flip drives both the indicator (this state) and the Reactor (setEnabled, whose
  // off→on transition catch-up reconciles). When no Reactor is wired (board-only
  // tests) the toggle is harmless local state.
  const [autoRunOn, setAutoRunOn] = useState(true);
  const autoRun = {
    enabled: autoRunOn,
    toggle: () => {
      // Derive `next` from the actual previous state, not this render's closure,
      // so two presses buffered into one stdin chunk (both handlers run before a
      // re-render) each flip rather than collapsing to one. The Reactor side
      // effect lives in the updater too, so the indicator and the Reactor stay in
      // lockstep on every flip.
      setAutoRunOn((prev) => {
        const next = !prev;
        options.reactor?.setEnabled(next);
        return next;
      });
    },
  };
  return (
    <App
      board={board}
      dispatcher={dispatcher}
      reviewer={reviewer}
      rollback={rollback}
      autoRun={autoRun}
    />
  );
}
