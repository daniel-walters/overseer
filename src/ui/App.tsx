import React, { useReducer, useState } from "react";
import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { ReviewPreview } from "./ReviewPreview.js";
import { HelpModal } from "./HelpModal.js";
import { navReduce, initialNav } from "./navigation.js";
import { matchKeybind, type KeybindHandlers } from "./keybinds.js";
import { RedispatchPreview } from "./RedispatchPreview.js";
import { KillPreview } from "./KillPreview.js";
import { OpenPrPreview, type OpenPrPreviewData } from "./OpenPrPreview.js";
import type { OpenPrResult } from "../dispatch/openPr.js";
import type { Board } from "../model.js";
import type { FrontierEntry } from "../dispatch/frontier.js";
import type { ReviewPreview as ReviewPreviewData } from "../review/reviewReader.js";
import type {
  RedispatchPreview as RedispatchPreviewData,
  RollbackOutcome,
} from "../dispatch/rollback.js";
import type {
  KillPreview as KillPreviewData,
  KillOutcome,
} from "../dispatch/kill.js";
import type { ReactorActivity } from "../reactor/reactorActivity.js";

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

/**
 * The rollback seam the App drives at the Issue level — the recovery
 * counterpart to {@link Reviewer}, used by the `R` keybind on an orphaned card.
 *
 * - `readRollback` resolves the selected Issue into a re-dispatch preview
 *   (`undefined` if it vanished from the watched root).
 * - `rollback` re-reads the previewed orphan from disk and rolls it back onto
 *   its frontier (`in-progress → ready-for-agent`, `in-review →
 *   ready-for-review`). It spawns nothing — the normal spawn edge re-picks the
 *   Issue up. It returns a {@link RollbackOutcome} so the App can tell the human
 *   "recovered" apart from the silent "nothing to recover" (the agent wasn't
 *   actually dead, or the Issue vanished).
 */
export interface Rollback {
  readonly readRollback: (
    prdId: string,
    issueId: string,
  ) => RedispatchPreviewData | undefined;
  readonly rollback: (preview: RedispatchPreviewData) => RollbackOutcome;
}

/**
 * The kill seam the App drives at the Issue level — the live-agent counterpart
 * to {@link Rollback}, used by the `K` keybind on a `live` card (ADR 0010).
 *
 * - `readKill` resolves the selected Issue into a kill preview with the recorded
 *   agent handle frozen (`undefined` if it vanished, or the `live` card had no
 *   recorded handle — a verdict/sidecar race).
 * - `kill` runs `claude stop` on the previewed handle and returns a
 *   {@link KillOutcome}, so the App can tell `stopped` from `not-running` (the
 *   agent had already gone) and `uncertain` (the stop could not be confirmed). It
 *   writes no status — the stopped agent's Issue orphans and `R` recovers it.
 */
export interface Killer {
  readonly readKill: (
    prdId: string,
    issueId: string,
  ) => KillPreviewData | undefined;
  readonly kill: (preview: KillPreviewData) => KillOutcome;
}

/**
 * The Open PR seam the App drives at the PRD level — the board's first outward
 * GitHub write (CONTEXT.md), the `done`-gated sibling of {@link Dispatcher}'s `d`.
 *
 * - `readOpenPr` resolves the selected `done` PRD into an Open PR preview: the
 *   derived feature branch, the resolved default base, and whether the action can
 *   proceed or is refused (the single-repo guard, or a branch that already has a
 *   PR). `undefined` if the PRD vanished from the watched root.
 * - `openPr` runs the action over a previewed PRD (push the branch, create the PR)
 *   and returns an {@link OpenPrResult}, so the App can surface the new PR's url or
 *   a loud `gh`/`git` failure on the status line. A no-op for a refused preview.
 */
export interface OpenPr {
  readonly readOpenPr: (prdId: string) => OpenPrPreviewData | undefined;
  readonly openPr: (preview: OpenPrPreviewData) => OpenPrResult;
}

/**
 * What the open modal is previewing: a PRD dispatch, a single-Issue review, a
 * single-orphan re-dispatch, a single-agent kill, or a PRD Open PR. At most one
 * is ever open (the `nav.confirming` guard).
 */
type ActiveModal =
  | { readonly kind: "dispatch"; readonly prdTitle: string; readonly frontier: readonly FrontierEntry[] }
  | { readonly kind: "review"; readonly preview: ReviewPreviewData }
  | { readonly kind: "redispatch"; readonly preview: RedispatchPreviewData }
  | { readonly kind: "kill"; readonly preview: KillPreviewData }
  | { readonly kind: "open-pr"; readonly preview: OpenPrPreviewData };

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
  /** Wired in production; absent in tests that don't exercise orphan recovery. */
  rollback?: Rollback;
  /** Wired in production; absent in tests that don't exercise the kill switch. */
  killer?: Killer;
  /** Wired in production; absent in tests that don't exercise Open PR. */
  openPr?: OpenPr;
  /** Wired in production; absent in tests that don't exercise auto-run. */
  autoRun?: AutoRun;
  /**
   * The board-level reactor-activity signal (working / idle / at-rest), derived
   * from in-memory Reactor state and recomputed on each rebuild (Issue: surface
   * reactor state). A second, distinct status-line indicator beside the auto-run
   * on/off one: auto-run answers "is the brake released?", this answers "given
   * that, is the Reactor moving?". Absent in board-only tests (and when no Reactor
   * is wired), where its half of the status line is simply empty.
   */
  activity?: ReactorActivity;
}

/**
 * The root Ink component. It owns UI state (selection + zoom level + the modal
 * preview) via the navigation reducer, kept separate from `board` so a live
 * re-scan never clobbers the user's place. Keys drive the reducer; `q` quits,
 * backing out of a zoom first; `d` (board level) opens the dispatch preview, `r`
 * (Issue level) opens the review preview, Enter/`y` confirms, `Esc` cancels.
 */
export function App({ board, dispatcher, reviewer, rollback, killer, openPr, autoRun, activity }: AppProps) {
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
  // A one-line transient notice shown on the status line — currently only the
  // outcome of a re-dispatch confirm (ADR 0009), so the human can tell a real
  // recovery from the silent "nothing to recover" no-op (the agent wasn't
  // actually dead, or the Issue vanished). Cleared on the next keypress.
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // Clamp the stored selection against the current board so a shrunk board
  // (after a live refresh) can never leave us pointing past the last card.
  const boardIndex = Math.min(nav.boardIndex, Math.max(0, board.prds.length - 1));
  const selectedPrd = board.prds[boardIndex];
  const issues = selectedPrd?.issues ?? [];
  const issueIndex = Math.min(nav.issueIndex, Math.max(0, issues.length - 1));
  const selectedIssue = issues[issueIndex];

  /**
   * The App-side closures the registry dispatches a matched keypress to. Each is
   * the body of one former inline `if` branch, including its App-state guards —
   * the registry has already applied the level gate, so a handler only fires when
   * its key matched at the right level.
   */
  const handlers: KeybindHandlers = {
    move: (delta) => {
      const count = nav.level === "board" ? board.prds.length : issues.length;
      dispatch({ type: "move", delta, count });
    },
    zoom: () => dispatch({ type: "zoom", issueCount: issues.length }),
    back: () => dispatch({ type: "back" }),
    dispatch: () => {
      if (dispatcher && selectedPrd) {
        setModal({
          kind: "dispatch",
          prdTitle: selectedPrd.title,
          frontier: dispatcher.readFrontier(selectedPrd.id),
        });
        dispatch({ type: "open-preview" });
      }
    },
    review: () => {
      if (reviewer && selectedPrd && selectedIssue) {
        const preview = reviewer.readReview(selectedPrd.id, selectedIssue.id);
        // A vanished Issue (raced a deletion) yields no preview — open nothing.
        if (preview) {
          setModal({ kind: "review", preview });
          dispatch({ type: "open-review" });
        }
      }
    },
    redispatch: () => {
      // Orphan recovery, Issue-level only (the registry gates the level). Gated
      // further on the card's own `orphaned` liveness marker — the same verdict
      // the card already renders — so `R` is a no-op on a healthy, unknown, or
      // non-active card. `readRollback` resolves the orphan once and freezes it on
      // the modal; a vanished Issue (raced a deletion) yields no preview.
      if (rollback && selectedPrd && selectedIssue?.liveness === "orphaned") {
        const preview = rollback.readRollback(selectedPrd.id, selectedIssue.id);
        if (preview) {
          setModal({ kind: "redispatch", preview });
          dispatch({ type: "open-review" });
        }
      }
    },
    kill: () => {
      // Kill, Issue-level only (the registry gates the level). Gated further on
      // the card's own `live` liveness marker — only a running agent Overseer
      // recorded can be stopped — so `K` is a no-op on an orphaned, unknown, or
      // non-active card. `readKill` freezes the recorded handle on the modal; a
      // vanished Issue, or a `live` card with no recorded handle (a verdict/sidecar
      // race), yields no preview (ADR 0010).
      if (killer && selectedPrd && selectedIssue?.liveness === "live") {
        const preview = killer.readKill(selectedPrd.id, selectedIssue.id);
        if (preview) {
          setModal({ kind: "kill", preview });
          dispatch({ type: "open-review" });
        } else {
          // The card read `live` but readKill found no recorded handle (the
          // verdict/sidecar race, or the Issue vanished). Without this notice the
          // keypress would do nothing at all — indistinguishable from K being
          // broken — so say plainly there's nothing to stop.
          setNotice(`${selectedIssue.id} has no recorded agent to stop — re-check the board.`);
        }
      }
    },
    openPr: () => {
      // Open PR, board-level only (the registry gates the level). Gated further on
      // the selected PRD's own derived `done` lane — the sole column a finished
      // PRD's feature branch can be PR'd from — so `P` is a no-op on a backlog /
      // in-progress PRD, mirroring how the kill/redispatch handlers gate on a
      // card's liveness. `readOpenPr` resolves the branch + base + eligibility once
      // and freezes it on the modal; a vanished PRD (raced a deletion) yields no
      // preview, so nothing opens.
      if (openPr && selectedPrd?.lane === "done") {
        const preview = openPr.readOpenPr(selectedPrd.id);
        if (preview) {
          setModal({ kind: "open-pr", preview });
          dispatch({ type: "open-preview" });
        }
      }
    },
    toggleAutoRun: () => autoRun?.toggle(),
    showHelp: () => setShowHelp(true),
    quit: () => {
      if (nav.level === "issues") dispatch({ type: "back" });
      else exit();
    },
  };

  useInput((input, key) => {
    // Any keypress dismisses a lingering rollback notice — it is a one-shot
    // outcome line, not persistent chrome. Cleared up front so even the keypress
    // that opened the help/modal below first wipes the stale notice.
    if (notice !== undefined) setNotice(undefined);

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

    // Past the modal/help guards, the live board owns input. Dispatch the
    // keypress off the central registry rather than an inline `if (input === …)`
    // chain: find the binding for this key at the current level and run its
    // action against the `handlers` bag above. The registry owns the key→action
    // map and the level gate (board / issues / both); those handlers own the
    // App-state gates the registry can't see — a seam being wired, an Issue being
    // selected, a card's liveness verdict — and stay no-ops when those aren't met.
    const bind = matchKeybind({ input, key }, nav.level);
    bind?.action(handlers, { input, key });
  });

  /** Act on the frozen modal capture: dispatch a frontier, or review an Issue. */
  function confirmModal(): void {
    if (modal?.kind === "dispatch") {
      dispatcher?.dispatch(modal.frontier);
    } else if (modal?.kind === "review" && modal.preview.eligibility.reviewable) {
      // An ineligible Issue's preview is a read-only skip notice: confirm spawns
      // nothing, it just dismisses (the reviewer would no-op anyway).
      reviewer?.review(modal.preview);
    } else if (modal?.kind === "redispatch") {
      // Roll the orphan back onto its frontier; the normal spawn edge re-picks
      // it up. No spawn happens here. `rollback` re-reads the Issue from disk, so
      // a status that advanced under the modal (a not-actually-dead agent) is a
      // no-op — surfaced via the outcome so the human isn't left with a confirm
      // that silently did nothing (ADR 0009).
      const outcome = rollback?.rollback(modal.preview);
      const issueId = modal.preview.issueId;
      if (outcome === "rolled-back") {
        setNotice(`Rolled ${issueId} back onto its frontier for re-dispatch.`);
      } else if (outcome === "advanced") {
        setNotice(`${issueId} already advanced past its orphan state — nothing to recover.`);
      } else if (outcome === "vanished") {
        setNotice(`${issueId} is gone from the board — nothing to recover.`);
      }
    } else if (modal?.kind === "kill") {
      // Stop the live agent via `claude stop` on the frozen handle. Writes no
      // status, so the Issue orphans and `R` recovers it (ADR 0010). The board's
      // next scan is the source of truth, so `uncertain` only sets honest
      // expectations rather than claiming anything authoritative.
      const outcome = killer?.kill(modal.preview);
      const issueId = modal.preview.issueId;
      if (outcome === "stopped") {
        setNotice(`Stopped ${issueId}'s agent — recover it with R.`);
      } else if (outcome === "not-running") {
        setNotice(`${issueId}'s agent is no longer running — nothing to stop.`);
      } else if (outcome === "uncertain") {
        setNotice(`Couldn't confirm ${issueId}'s agent stopped — re-check the board.`);
      } else if (outcome === "unavailable") {
        setNotice(`Couldn't run \`claude stop\` — is the claude CLI on your PATH?`);
      }
    } else if (modal?.kind === "open-pr" && modal.preview.eligibility.canOpen) {
      // Push the branch then open the PR (the orchestration does both, in order).
      // A refused preview (>1 repo, or an existing PR) is a read-only notice:
      // confirm does nothing, it just dismisses — its `canOpen` is false, so this
      // branch is skipped. A `gh`/`git` failure comes back as a failed result and
      // surfaces loudly on the status line, like a spawn failure; success surfaces
      // the new PR's url. The PRD's `done` column is unchanged either way (ADR
      // 0003) — the new PR shows via the Linked PR overlay on the next scan.
      const result = openPr?.openPr(modal.preview);
      if (result?.ok) {
        setNotice(`Opened PR for ${modal.preview.prdTitle}: ${result.url}`);
      } else if (result) {
        setNotice(`Couldn't open PR for ${modal.preview.prdTitle}: ${result.error}`);
      }
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
  if (modal?.kind === "redispatch") {
    return <RedispatchPreview preview={modal.preview} />;
  }
  if (modal?.kind === "kill") {
    return <KillPreview preview={modal.preview} />;
  }
  if (modal?.kind === "open-pr") {
    return <OpenPrPreview preview={modal.preview} />;
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
      {/* Help is an overlay, not a takeover: the board above stays mounted and
          visible behind it (the surrounding columns and the bottom bar show
          through — a terminal can't z-layer or dim a whole subtree) so the user
          keeps their place, with the help card composited over the lower region.
          It can only be open when no preview is (the nav.confirming guard blocks
          `?` under one), so at most one modal is ever on screen. */}
      {showHelp && (
        <Box flexShrink={0}>
          <HelpModal />
        </Box>
      )}
      {notice !== undefined && (
        <Box flexShrink={0}>
          <Text color="yellow">{notice}</Text>
        </Box>
      )}
      <Box flexShrink={0}>
        <StatusLine autoRun={autoRun} activity={activity} />
      </Box>
    </Box>
  );
}

/**
 * The display text and colour for the board-level reactor-activity indicator,
 * keyed by {@link ReactorActivity}. Each rides a glyph + word so the three states
 * read at a glance, and the colour grades the urgency: **working** green (the
 * Reactor is moving), **idle** dim (on, but quietly waiting — not an alarm),
 * **at-rest** dim (braked, expected stillness). Deliberately quiet overall: an
 * actively-spawning board is the "good" state, and the loud colours are reserved
 * for the per-card markers (suppressed red, orphan yellow) where attention is
 * actually needed.
 */
const ACTIVITY_INDICATOR: Record<
  ReactorActivity,
  { text: string; color?: string; dim?: boolean }
> = {
  working: { text: "⚙ working", color: "green" },
  idle: { text: "… idle", dim: true },
  "at-rest": { text: "□ at-rest", dim: true },
};

/**
 * The persistent bottom-row keybind hints, surfacing the primary gestures so they
 * are discoverable without opening `?`. The `d` dispatch ignition leads, followed
 * by its siblings and the `? help` pointer to the full map. A hardcoded copy of
 * the bindings the {@link App} input handler implements — a central keybind
 * registry that would feed both this and {@link HelpModal} is a logged follow-up
 * (docs/ideas.md), and this Issue does not depend on it.
 */
const KEY_HINTS: readonly string[] = [
  "d dispatch",
  "r review",
  "P open PR",
  "? help",
];

/**
 * The persistent board status line: the auto-run indicator and the reactor
 * activity signal on the left, the keybind hints pushed to the right by a
 * {@link Spacer}, with explicit spacing between the two so they read as distinct
 * elements even when the bar is narrow and the Spacer collapses.
 *
 * The auto-run indicator is always shown when its seam is wired — an idle
 * on-Reactor and an off one both leave the board still, so the off state must be
 * legible (ADR 0007). The **activity** signal sits beside it as a *distinct*
 * element (Issue: surface reactor state): auto-run on/off is the brake; activity
 * is whether the Reactor is moving — working / idle / at-rest. Both are absent in
 * board-only tests (their halves of the line simply empty), derived from
 * in-memory Reactor state, never written to disk (ADR 0002).
 *
 * The hints, by contrast, are *always* shown regardless of either seam: they are
 * what make the keybinds discoverable, so they must not hinge on a Reactor being
 * present. "auto-run"/"working"/"idle"/"at-rest" — never "reactor".
 */
function StatusLine({
  autoRun,
  activity,
}: {
  autoRun?: AutoRun;
  activity?: ReactorActivity;
}) {
  const indicator = activity ? ACTIVITY_INDICATOR[activity] : undefined;
  return (
    <Box>
      {autoRun ? (
        <Text dimColor>
          {autoRun.enabled ? "▶ auto-run on" : "⏸ auto-run off"}
        </Text>
      ) : null}
      {indicator ? (
        <Text dimColor={indicator.dim} color={indicator.color}>
          {autoRun ? "  " : ""}
          {indicator.text}
        </Text>
      ) : null}
      <Spacer />
      {/* A fixed gap guarantees separation from the auto-run indicator even when
          the content-sized bar leaves the Spacer with nothing to push apart. */}
      {autoRun ? <Text>{"   "}</Text> : null}
      <Text dimColor>{KEY_HINTS.join("  ·  ")}</Text>
    </Box>
  );
}
