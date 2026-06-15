import { useEffect, useState } from "react";
import type { Board } from "../model.js";
import type { Reactor } from "../reactor/reactor.js";

export interface UseLiveBoardOptions {
  /** The configured root being watched. */
  readonly root: string;
  /** The board from the eager first scan, rendered before any change fires. */
  readonly initialBoard: Board;
  /** Re-scan the root into a fresh Board (defaults wired in cli.tsx). */
  readonly scan: (root: string) => Board;
  /** Watch the root, calling back on each debounced change; returns teardown. */
  readonly watch: (root: string, onChange: () => void) => () => void;
  /**
   * The Reactor, reconciled after each board rebuild so completing one Issue
   * cascades to its newly-unblocked siblings with no keypress. Absent in
   * board-only tests; when absent the loop is a plain re-scan.
   */
  readonly reactor?: Reactor;
  /**
   * Called right after each post-rebuild reconcile, so the caller can re-read the
   * Reactor's activity and refresh the status-line signal (Issue: surface reactor
   * state). Absent in board-only tests. The hook itself holds no activity state —
   * the caller owns that single source of truth.
   */
  readonly onReconciled?: () => void;
}

/**
 * Hold the live board: start from the eager first scan, then re-scan and
 * re-render on every debounced filesystem change, tearing the watcher down on
 * unmount. The board is the only thing the *scan* changes here — UI state
 * (selection, zoom) lives in the navigation reducer, so a refresh never clobbers
 * the user's place.
 *
 * After each post-rebuild reconcile it fires {@link UseLiveBoardOptions.onReconciled},
 * so the caller (LiveApp) can re-read the Reactor's {@link ReactorActivity} and
 * surface whether that pass spawned (working) or found nothing (idle). The
 * activity signal is owned by the caller — a single source of truth it also
 * updates on the auto-run toggle's own at-rest transition — rather than mirrored
 * here, so the indicator never lags a render behind on either driver.
 */
export function useLiveBoard({
  root,
  initialBoard,
  scan,
  watch,
  reactor,
  onReconciled,
}: UseLiveBoardOptions): Board {
  const [board, setBoard] = useState(initialBoard);

  useEffect(() => {
    const teardown = watch(root, () => {
      // Rebuild the board first, then let the Reactor act on the same on-disk
      // state it reflects: level-triggered, the spawn it drives writes status to
      // disk, which fires another debounced change → another reconcile, so one
      // `d` cascades through the dependency graph (ADR 0005). reconcile() holds
      // its own re-entrancy guard, so overlapping passes are a clean no-op.
      setBoard(scan(root));
      reactor?.reconcile();
      // The reconcile just updated the Reactor's in-memory tally; notify the
      // caller so it can publish the fresh activity signal in the same tick.
      onReconciled?.();
    });
    return teardown;
  }, [root, scan, watch, reactor, onReconciled]);

  return board;
}
