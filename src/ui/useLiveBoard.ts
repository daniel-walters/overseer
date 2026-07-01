import { useCallback, useEffect, useState } from "react";
import type { Board } from "../model.js";
import type { Reactor } from "../reactor/reactor.js";

/**
 * The board's view of the JIRA mirror: a fire-and-forget reconcile fed the
 * freshly-scanned board after each rebuild. Narrowed to just this method (and a
 * `void` return) so the UI layer stays free of the mirror's internals — the CLI
 * wires the real reconciler behind it, scheduled off the render path.
 */
export interface BoardMirror {
  reconcile(board: Board): void;
}

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
   * The JIRA mirror, reconciled fire-and-forget after each board rebuild — the
   * in-process sibling of the Linked-PR overlay (ADR 0028 / 0013). It is handed
   * the freshly-scanned board and pushes each opted-in PRD's epic to JIRA off the
   * render path; the board never blocks on it and it never throws out (the wiring
   * schedules it asynchronously and it swallows its own failures as logged
   * no-ops). Absent in board-only tests and whenever no mirror is wired.
   */
  readonly mirror?: BoardMirror;
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
 *
 * Alongside the board it returns a stable `refresh` callback that runs the same
 * rebuild+reconcile the watcher does. The watcher only fires on *filesystem*
 * changes, so an action that mutates state the scan reads but never touches the
 * watched root — opening a PR is a GitHub write (issue #66) — would otherwise
 * leave the board stale until the next unrelated FS event. The caller invokes
 * `refresh` after such an action to re-scan on demand.
 */
export interface UseLiveBoard {
  /** The live board, re-scanned on each FS change and on each `refresh`. */
  readonly board: Board;
  /**
   * Re-scan the root now, running the same rebuild+reconcile the watcher does.
   * Stable across renders, so callers can hold it without re-subscribing.
   */
  readonly refresh: () => void;
}

export function useLiveBoard({
  root,
  initialBoard,
  scan,
  watch,
  reactor,
  mirror,
  onReconciled,
}: UseLiveBoardOptions): UseLiveBoard {
  const [board, setBoard] = useState(initialBoard);

  // The single rebuild+reconcile path both the watcher and `refresh` drive:
  // rebuild the board first, then let the Reactor act on the same on-disk state
  // it reflects: level-triggered, the spawn it drives writes status to disk,
  // which fires another debounced change → another reconcile, so one `d`
  // cascades through the dependency graph (ADR 0005). reconcile() holds its own
  // re-entrancy guard, so overlapping passes are a clean no-op. The reconcile
  // just updated the Reactor's in-memory tally; notify the caller so it can
  // publish the fresh activity signal in the same tick.
  const refresh = useCallback(() => {
    const next = scan(root);
    setBoard(next);
    reactor?.reconcile();
    // Fire-and-forget the JIRA mirror on the same rebuilt board (ADR 0028): it
    // pushes each opted-in PRD's epic off the render path and never blocks the
    // board or throws out. Passed the just-scanned board so it reconciles against
    // exactly what the user sees, not a re-read.
    mirror?.reconcile(next);
    onReconciled?.();
  }, [root, scan, reactor, mirror, onReconciled]);

  useEffect(() => {
    const teardown = watch(root, refresh);
    return teardown;
  }, [root, watch, refresh]);

  return { board, refresh };
}
