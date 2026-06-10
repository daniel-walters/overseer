import React, { useReducer, useState } from "react";
import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { ReviewPreview } from "./ReviewPreview.js";
import { HelpModal } from "./HelpModal.js";
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

/**
 * The auto-run switch the App reflects and drives — the user-facing name for the
 * Reactor's on/off state ("reactor" stays internal vocabulary). `enabled` feeds
 * the persistent status-line indicator; `toggle` is called by the `a` keybind.
 * A seam, not the Reactor itself, so the keybind and indicator are testable
 * without a real Reactor (mirroring {@link Dispatcher}/{@link Reviewer}).
 */
export interface AutoRun {
  readonly enabled: boolean;
  readonly toggle: () => void;
}

interface AppProps {
  board: Board;
  /** Wired in production; absent in tests that don't exercise dispatch. */
  dispatcher?: Dispatcher;
  /** Wired in production; absent in tests that don't exercise review. */
  reviewer?: Reviewer;
  /** Wired in production; absent in tests that don't exercise auto-run. */
  autoRun?: AutoRun;
}

/**
 * The root Ink component. It owns UI state (selection + zoom level + the modal
 * preview) via the navigation reducer, kept separate from `board` so a live
 * re-scan never clobbers the user's place. Keys drive the reducer; `q` quits,
 * backing out of a zoom first; `d` (board level) opens the dispatch preview, `r`
 * (Issue level) opens the review preview, Enter/`y` confirms, `Esc` cancels.
 */
export function App({ board, dispatcher, reviewer, autoRun }: AppProps) {
  const { exit } = useApp();
  // The terminal dimensions, reactive to resize (SIGWINCH). The board renders on
  // the alternate screen (cli.tsx) sized to fill the viewport, so the root box is
  // pinned to the window height with the status line pushed to the bottom row.
  // Overflow beyond the viewport clips — the alt screen has no scrollback, and
  // in-app scrolling is a logged follow-up (docs/ideas.md).
  const { rows } = useWindowSize();
  const [nav, dispatch] = useReducer(navReduce, initialNav);
  // The plan captured when a preview opened — the dispatch frontier / review
  // preview a confirm acts on, and what the modal renders. Frozen at open time
  // and held outside the reducer (it's data, not nav) so a live re-scan under
  // the modal can never re-point the header or the action at a different
  // PRD/Issue, nor leave the modal stranded if its card disappears. Set when a
  // preview opens and cleared (`undefined`) when it closes, so `modal?.kind`
  // alone drives the render — `nav.confirming` only owns input/navigation
  // suppression, the two are never read together.
  const [modal, setModal] = useState<ActiveModal | undefined>(undefined);
  // The help modal's open state, kept separate from `modal` — help is a passive
  // reference card with no frozen capture and no confirm side-effect, so it does
  // not belong in the action-preview `ActiveModal` union. The `nav.confirming`
  // guard below suppresses `?` while a preview is up, so help and a preview are
  // never both open: at most one modal on screen, ever.
  const [showHelp, setShowHelp] = useState(false);

  // Clamp the stored selection against the current board so a shrunk board
  // (after a live refresh) can never leave us pointing past the last card.
  const boardIndex = Math.min(nav.boardIndex, Math.max(0, board.prds.length - 1));
  const selectedPrd = board.prds[boardIndex];
  const issues = selectedPrd?.issues ?? [];
  const issueIndex = Math.min(nav.issueIndex, Math.max(0, issues.length - 1));
  const selectedIssue = issues[issueIndex];

  useInput((input, key) => {
    // The help modal owns input while it is open: ? or Esc close it, q closes it
    // and quits, everything else is swallowed (so a stray key while reading help
    // never leaks to the board underneath).
    if (showHelp) {
      if (input === "?" || key.escape) {
        setShowHelp(false);
      } else if (input === "q") {
        setShowHelp(false);
        exit();
      }
      return;
    }

    // The modal preview owns input while it is open: confirm, cancel, or quit.
    if (nav.confirming) {
      if (key.return || input === "y") {
        confirmModal();
        setModal(undefined);
        dispatch({ type: "confirm" });
      } else if (key.escape) {
        setModal(undefined);
        dispatch({ type: "cancel" });
      } else if (input === "q") {
        // `q` quits everywhere else; keep that escape hatch from the modal too —
        // cancel the preview (leaving the board untouched), then exit.
        setModal(undefined);
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

    if (input === "?") {
      // Opens the keybind reference, at either level. Reached only past the
      // nav.confirming guard above, so an open preview suppresses it — help and a
      // preview are never both up.
      setShowHelp(true);
      return;
    }

    if (input === "a") {
      // The global auto-run brake. Unlike d/r it is not level-scoped — it acts on
      // nothing under the cursor, so it works wherever you are. (The modal already
      // swallowed input above via the nav.confirming guard.)
      autoRun?.toggle();
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
  // `modal` is set only while a preview is open and cleared on close, so its
  // kind alone selects the modal — no need to also consult `nav.confirming`.
  if (modal?.kind === "dispatch") {
    return <DispatchPreview prdTitle={modal.prdTitle} frontier={modal.frontier} />;
  }
  if (modal?.kind === "review") {
    return <ReviewPreview preview={modal.preview} />;
  }
  // The help modal is a full-screen takeover like the previews above. It can only
  // be open when no preview is (the nav.confirming guard blocks `?` under one), so
  // ordering against the preview returns is moot — at most one is ever set.
  if (showHelp) {
    return <HelpModal />;
  }
  // The live board levels share a persistent status line carrying the auto-run
  // indicator. (Modals return above, so the indicator never shows over a preview.)
  const view =
    nav.level === "issues" && selectedPrd ? (
      <IssueBoard prd={selectedPrd} selectedIndex={issueIndex} />
    ) : (
      <BoardView board={board} selectedIndex={boardIndex} />
    );
  // The view sits in a flex-shrinking region that clips under overflow; the
  // status line is held at fixed size (flexShrink={0}) so it is never the thing
  // pushed off-screen. Without this, a board taller than the viewport consumes
  // every row and the trailing Spacer + status line clip past the bottom edge —
  // taking the auto-run indicator with them, which ADR 0007 requires stay legible.
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        {view}
      </Box>
      <Spacer />
      <Box flexShrink={0}>
        <StatusLine autoRun={autoRun} />
      </Box>
    </Box>
  );
}

/**
 * The persistent board status line: the auto-run indicator on the left, the
 * `? help` discovery hint pushed to the right by a {@link Spacer}.
 *
 * The auto-run indicator is always shown when its seam is wired — an idle
 * on-Reactor and an off one both leave the board still, so the off state must be
 * legible (ADR 0007). When no seam is wired (board-only tests) its half is empty.
 * The `? help` hint, by contrast, is *always* shown regardless of the auto-run
 * seam: it is what makes `?` discoverable, so it must not hinge on a Reactor being
 * present. "auto-run", never "reactor".
 */
function StatusLine({ autoRun }: { autoRun?: AutoRun }) {
  return (
    <Box>
      {autoRun ? (
        <Text dimColor>
          {autoRun.enabled ? "▶ auto-run on" : "⏸ auto-run off"}
        </Text>
      ) : null}
      <Spacer />
      <Text dimColor>? help</Text>
    </Box>
  );
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
