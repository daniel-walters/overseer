import React, { useCallback, useState } from "react";
import { App, type Dispatcher, type Reviewer, type Auditor, type Rollback, type Killer, type OpenPr, type Delete, type MarkDone, type Approve, type DetailReader, type AgentOutputReader, type UrlOpener } from "./App.js";
import { useLiveBoard, type UseLiveBoardOptions } from "./useLiveBoard.js";

export interface LiveAppProps extends UseLiveBoardOptions {
  /** The dispatch seams, wired in cli.tsx; absent in board-only tests. */
  readonly dispatcher?: Dispatcher;
  /** The review seams, wired in cli.tsx; absent in board-only tests. */
  readonly reviewer?: Reviewer;
  /** The manual audit-crank seam (`c`), wired in cli.tsx; absent in board-only tests. */
  readonly auditor?: Auditor;
  /** The orphan-recovery seam, wired in cli.tsx; absent in board-only tests. */
  readonly rollback?: Rollback;
  /** The kill-switch seam, wired in cli.tsx; absent in board-only tests. */
  readonly killer?: Killer;
  /** The Open PR seam, wired in cli.tsx; absent in board-only tests. */
  readonly openPr?: OpenPr;
  /** The Delete PRD seam, wired in cli.tsx; absent in board-only tests. */
  readonly deleter?: Delete;
  /** The Mark done seam, wired in cli.tsx; absent in board-only tests. */
  readonly markDone?: MarkDone;
  /** The Approve seam, wired in cli.tsx; absent in board-only tests. */
  readonly approve?: Approve;
  /** The detail-modal read seam, wired in cli.tsx; absent in board-only tests. */
  readonly detailReader?: DetailReader;
  /** The agent-output read seam (`o`), wired in cli.tsx; absent in board-only tests. */
  readonly agentOutputReader?: AgentOutputReader;
  /** The browser seam `go to PR` opens through; wired in cli.tsx, absent in tests. */
  readonly urlOpener?: UrlOpener;
  /**
   * The configured AI-review cap (`config.review.cap`), forwarded to {@link App} as
   * the denominator of the `N/cap` review-pass marker (ADR 0018). Wired in cli.tsx
   * from config; absent in board-only tests.
   */
  readonly reviewCap?: number;
}

// `reactor` rides in via UseLiveBoardOptions, consumed by useLiveBoard rather
// than App, so it is not re-declared here.

/**
 * The live root: feed {@link App} a board that re-scans on every debounced
 * filesystem change. App owns UI state (selection, zoom, the dispatch/review
 * preview) separately from the board, so a refresh under the user's feet never
 * loses their place. The dispatcher and reviewer are threaded straight through.
 */
export function LiveApp({ dispatcher, reviewer, auditor, rollback, killer, openPr, deleter, markDone, approve, detailReader, agentOutputReader, urlOpener, reviewCap, ...options }: LiveAppProps) {
  const reactor = options.reactor;
  // The board-level reactor-activity signal shown beside the auto-run indicator
  // (Issue: surface reactor state). LiveApp owns it as a single source of truth,
  // seeded from the Reactor's current state (a fresh on-Reactor reads idle), and
  // re-reads `reactor.activity()` on each of its two drivers: a post-rebuild
  // reconcile (via the live loop's onReconciled below) and the auto-run toggle
  // (which flips the Reactor on/off with no filesystem event). Absent when no
  // Reactor is wired (board-only tests) — its status-line half stays empty.
  const [activity, setActivity] = useState(() => reactor?.activity());
  // Stable so it can be a useLiveBoard effect dependency without re-subscribing
  // the watcher every render. Fires after each reconcile to publish the fresh
  // signal in the same tick the board rebuilt.
  const onReconciled = useCallback(() => {
    setActivity(reactor?.activity());
  }, [reactor]);
  const { board, refresh } = useLiveBoard({ ...options, onReconciled });
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
        reactor?.setEnabled(next);
        // Re-read the Reactor's activity after the flip: disabling makes it report
        // at-rest immediately, and re-enabling runs a catch-up reconcile that may
        // flip it to working — neither involves a filesystem event, so the
        // indicator would otherwise lag until the next board rebuild.
        setActivity(reactor?.activity());
        return next;
      });
    },
  };
  return (
    <App
      board={board}
      dispatcher={dispatcher}
      reviewer={reviewer}
      auditor={auditor}
      rollback={rollback}
      killer={killer}
      openPr={openPr}
      deleter={deleter}
      markDone={markDone}
      approve={approve}
      detailReader={detailReader}
      agentOutputReader={agentOutputReader}
      autoRun={autoRun}
      urlOpener={urlOpener}
      activity={activity}
      refresh={refresh}
      reviewCap={reviewCap}
    />
  );
}
