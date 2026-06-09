import React, { useReducer, useState } from "react";
import { useApp, useInput } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { ReviewPreview } from "./ReviewPreview.js";
import { navReduce, initialNav } from "./navigation.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";

/**
 * The dispatch seams the App drives, injected so the keypress → preview →
 * confirm flow is testable without filesystem reads or real agents.
 *
 * - `readFrontier` reads the selected PRD's dispatch view and computes its
 *   frontier for the preview (and, on confirm, the flip+spawn to act on).
 * - `dispatch` runs the dispatch over that frontier (flip each spawn candidate
 *   to in-progress, then spawn it).
 */
export interface Dispatcher {
  readonly readFrontier: (prdId: string) => readonly FrontierEntry[];
  readonly dispatch: (frontier: readonly FrontierEntry[]) => void;
}

/**
 * The review seams the App drives at the Issue level, the deliberate per-Issue
 * counterpart to {@link Dispatcher}'s per-PRD wave.
 *
 * - `readReview` resolves the selected Issue and classifies its reviewability
 *   for the preview (`undefined` if it vanished from the watched root).
 * - `review` runs the review over a previewed Issue (flip `ready-for-review →
 *   in-review`, then spawn the reviewer) — a no-op for an ineligible Issue.
 */
export interface Reviewer {
  readonly readReview: (
    prdId: string,
    issueId: string,
  ) => ReviewPreviewData | undefined;
  readonly review: (preview: ReviewPreviewData) => void;
}

/** What the open modal is previewing: a PRD dispatch or a single-Issue review. */
type ActiveModal =
  | { readonly kind: "dispatch"; readonly prdTitle: string; readonly frontier: readonly FrontierEntry[] }
  | { readonly kind: "review"; readonly preview: ReviewPreviewData };

interface AppProps {
  board: Board;
  /** Wired in production; absent in tests that don't exercise dispatch. */
  dispatcher?: Dispatcher;
  /** Wired in production; absent in tests that don't exercise review. */
  reviewer?: Reviewer;
}

/**
 * The root Ink component. It owns UI state (selection + zoom level + the modal
 * preview) via the navigation reducer, kept separate from `board` so a live
 * re-scan never clobbers the user's place. Keys drive the reducer; `q` quits,
 * backing out of a zoom first; `d` (board level) opens the dispatch preview, `r`
 * (Issue level) opens the review preview, Enter/`y` confirms, `Esc` cancels.
 */
export function App({ board, dispatcher, reviewer }: AppProps) {
  const { exit } = useApp();
  const [nav, dispatch] = useReducer(navReduce, initialNav);
  // The plan captured when a preview opened — the dispatch frontier / review
  // target a confirm acts on, and what the modal renders. Frozen at open time
  // and held outside the reducer (it's data, not nav) so a live re-scan under
  // the modal can never re-point the header or the action at a different
  // PRD/Issue, nor leave the modal stranded if its card disappears.
  const [modal, setModal] = useState<ActiveModal | undefined>(undefined);

  // Clamp the stored selection against the current board so a shrunk board
  // (after a live refresh) can never leave us pointing past the last card.
  const boardIndex = Math.min(nav.boardIndex, Math.max(0, board.prds.length - 1));
  const selectedPrd = board.prds[boardIndex];
  const issues = selectedPrd?.issues ?? [];
  const issueIndex = Math.min(nav.issueIndex, Math.max(0, issues.length - 1));
  const selectedIssue = issues[issueIndex];

  useInput((input, key) => {
    // The modal preview owns input while it is open: confirm, cancel, or quit.
    if (nav.confirming) {
      if (key.return || input === "y") {
        confirmModal();
        dispatch({ type: "confirm" });
      } else if (key.escape) {
        dispatch({ type: "cancel" });
      } else if (input === "q") {
        // `q` quits everywhere else; keep that escape hatch from the modal too —
        // cancel the preview (leaving the board untouched), then exit.
        dispatch({ type: "cancel" });
        exit();
      }
      return;
    }

    if (input === "d") {
      if (nav.level === "board" && dispatcher && selectedPrd) {
        setModal({
          kind: "dispatch",
          prdTitle: selectedPrd.title,
          frontier: dispatcher.readFrontier(selectedPrd.id),
        });
        dispatch({ type: "open-preview" });
      }
      return;
    }

    if (input === "r") {
      if (nav.level === "issues" && reviewer && selectedPrd && selectedIssue) {
        const preview = reviewer.readReview(selectedPrd.id, selectedIssue.id);
        // A vanished Issue (raced a deletion) yields no preview — open nothing.
        if (preview) {
          setModal({ kind: "review", preview });
          dispatch({ type: "open-review" });
        }
      }
      return;
    }

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

  /** Act on the frozen modal capture: dispatch a frontier, or review an Issue. */
  function confirmModal(): void {
    if (modal?.kind === "dispatch") {
      dispatcher?.dispatch(modal.frontier);
    } else if (modal?.kind === "review" && modal.preview.eligibility.reviewable) {
      // An ineligible Issue's preview is a read-only skip notice: confirm spawns
      // nothing, it just dismisses (the reviewer would no-op anyway).
      reviewer?.review(modal.preview);
    }
  }

  // The modal renders from the frozen capture, not the live board, so it stays
  // up and correctly labelled even if a re-scan removes its PRD/Issue card.
  if (nav.confirming && modal?.kind === "dispatch") {
    return <DispatchPreview prdTitle={modal.prdTitle} frontier={modal.frontier} />;
  }
  if (nav.confirming && modal?.kind === "review") {
    return <ReviewPreview preview={modal.preview} />;
  }
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
