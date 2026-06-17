import React, { useReducer, useState } from "react";
import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { BoardView } from "./Board.js";
import { IssueBoard } from "./IssueBoard.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { ReviewPreview } from "./ReviewPreview.js";
import { HelpModal } from "./HelpModal.js";
import { DetailModal, DETAIL_MODAL_CHROME_ROWS } from "./DetailModal.js";
import { renderDetailLines } from "./markdown.js";
import { scrollDetail } from "./detailScroll.js";
import type { CardDetail } from "./detailReader.js";
import { navReduce, initialNav, selectedCoord } from "./navigation.js";
import { laneShape, cardAtCoord } from "./lanes.js";
import { laneHeight } from "./laneHeight.js";
import { matchKeybind, type KeybindHandlers } from "./keybinds.js";
import { RedispatchPreview } from "./RedispatchPreview.js";
import { KillPreview } from "./KillPreview.js";
import { OpenPrPreview, type OpenPrPreviewData } from "./OpenPrPreview.js";
import type { OpenPrResult } from "../dispatch/openPr.js";
import { BOARD_LANES, ISSUE_LANES } from "../model.js";
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
 * The detail seam the `v` keybind drives — the read-only body view (the first
 * presentation-only feature, ADR 0014), the passive sibling of the action seams
 * above. `readDetail` resolves the selected card's frontmatter-stripped body off
 * disk *when the modal opens*: with only a `prdId` (board level) it reads the
 * PRD's `prd.md`, with an `issueId` too (zoomed) the selected Issue file. A
 * vanished file yields `undefined`, on which `v` is a no-op (no modal) — the same
 * scan→keypress race the action seams degrade. Unlike them it has no confirm and
 * no write: the modal only reads, so a `CardDetail` is all it returns (the body is
 * never carried in the `Board` model, ADR 0003).
 */
export interface DetailReader {
  readonly readDetail: (prdId: string, issueId?: string) => CardDetail | undefined;
}

/**
 * What the open modal is previewing: a PRD dispatch, a single-Issue review, a
 * single-orphan re-dispatch, a single-agent kill, a PRD Open PR, or a read-only
 * card-body detail view. At most one is ever open (the `nav.confirming` guard for
 * the action previews; the detail modal closes over its own input like help).
 */
type ActiveModal =
  | { readonly kind: "dispatch"; readonly prdTitle: string; readonly frontier: readonly FrontierEntry[] }
  | { readonly kind: "review"; readonly preview: ReviewPreviewData }
  | { readonly kind: "redispatch"; readonly preview: RedispatchPreviewData }
  | { readonly kind: "kill"; readonly preview: KillPreviewData }
  | { readonly kind: "open-pr"; readonly preview: OpenPrPreviewData }
  | { readonly kind: "detail"; readonly detail: CardDetail };

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

/**
 * The browser seam the `go to PR` keybind drives — open a url in the default
 * browser. A seam, not a direct shell-out, so the keybind's gating (fire only
 * when the selected `done` PRD's Linked PR overlay reports a PR; no-op otherwise)
 * is testable without launching a real browser. The default impl shells out to
 * the platform open command; a test fake records the url. Mirrors {@link AutoRun}
 * and the dispatch seams: the App reaches GitHub only through an injected port.
 */
export interface UrlOpener {
  readonly open: (url: string) => void;
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
  /** Wired in production; absent in tests that don't exercise the detail modal. */
  detailReader?: DetailReader;
  /** Wired in production; absent in tests that don't exercise auto-run. */
  autoRun?: AutoRun;
  /** Wired in production; absent in tests that don't exercise `go to PR`. */
  urlOpener?: UrlOpener;
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
export function App({ board, dispatcher, reviewer, rollback, killer, openPr, detailReader, autoRun, urlOpener, activity }: AppProps) {
  const { exit } = useApp();
  // The terminal dimensions, reactive to resize (SIGWINCH). The board renders on
  // the alternate screen (cli.tsx) sized to fill the viewport, so the root box is
  // pinned to the window height with the status line pushed to the bottom row.
  // The same reactive read drives the vertical viewport scroll: each lane's
  // available card-row height is `rows` minus the chrome, recomputed on every
  // resize, so an overflowing lane scrolls to keep the selection in view rather
  // than clipping unreachable cards (ADR 0015). Horizontal overflow still clips —
  // the alt screen has no scrollback (ADR 0001) and horizontal paging is a logged
  // follow-up (docs/ideas.md).
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
  // The detail modal's scroll position over its body's *rendered* lines. Reset to
  // the top when the modal opens (so a reopen never resumes a stale position) and
  // moved by `j`/`k`/arrows while it is open, clamped to the body's bounds. Held
  // here (not on `modal`) because the modal capture is frozen at open time, but the
  // offset is live state the input handler updates on every keystroke.
  const [detailScroll, setDetailScroll] = useState(0);
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

  // Resolve the stored grid coordinate against the live board into the card it
  // selects (ADR 0015). The lane shape — the per-lane card counts — is derived
  // here on the render side and threaded into both the reducer's `move` action
  // and the view's highlight, so the reducer never sees the Board. `selectedCoord`
  // snaps the coordinate onto a real card under a live re-scan (an emptied lane,
  // or a row past a now-shorter lane), so selection never rests on nothing.
  const boardShape = laneShape(board.prds, BOARD_LANES);
  const boardSel = selectedCoord(nav.board, boardShape);
  const selectedPrd = cardAtCoord(board.prds, BOARD_LANES, boardSel);
  const issues = selectedPrd?.issues ?? [];
  const issueShape = laneShape(issues, ISSUE_LANES);
  const issueSel = selectedCoord(nav.issues, issueShape);
  const selectedIssue = cardAtCoord(issues, ISSUE_LANES, issueSel);
  // The lane shape for the level that currently owns input — what a `move`
  // carries so the pure reducer knows the grid's geometry.
  const activeShape = nav.level === "board" ? boardShape : issueShape;

  // The detail modal's body region height and its current scroll window. The
  // viewport is the terminal height minus the modal's fixed chrome (title, hints,
  // affordance rows); the body's rendered lines are windowed through the same
  // `scrollDetail` the modal renders from, so the App's keypress clamp and the
  // modal's window can never disagree. Only meaningful while a detail modal is
  // open; `maxOffset` is what `j`/`k`/arrows clamp the offset against.
  const detailBodyRows = Math.max(1, rows - DETAIL_MODAL_CHROME_ROWS);
  const detailLines =
    modal?.kind === "detail" ? renderDetailLines(modal.detail) : [];
  const detailMaxOffset = scrollDetail(detailLines, detailScroll, detailBodyRows).maxOffset;

  /**
   * The App-side closures the registry dispatches a matched keypress to. Each is
   * the body of one former inline `if` branch, including its App-state guards —
   * the registry has already applied the level gate, so a handler only fires when
   * its key matched at the right level.
   */
  const handlers: KeybindHandlers = {
    move: (dir) => dispatch({ type: "move", dir, lanes: activeShape }),
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
    goToPr: () => {
      // Board-level (the registry gates the level): the Linked PR overlay lives
      // on the PRD card. Gated further on the card's own `linkedPr` overlay — the
      // same live-query result the marker renders (open *or* merged, so a merged
      // PR's discussion stays reachable). It introduces no new `gh` query and no
      // outward write: it only reads the overlay's `url` and hands it to the
      // browser seam.
      if (!urlOpener || !selectedPrd) return;
      const linkedPr = selectedPrd.linkedPr;
      if (linkedPr) {
        urlOpener.open(linkedPr.url);
      } else {
        // No PR to open — never an error, just a clear status-line flash so the
        // keypress isn't indistinguishable from `g` being broken.
        setNotice(`${selectedPrd.title} has no PR to open.`);
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
    viewDetail: () => {
      // Read the selected card's body on demand and open the detail modal over it
      // (board-level: the PRD; zoomed: the selected Issue — the registry's `both`
      // gate lets one key serve both, the level here picks which id the seam gets).
      // A vanished file (raced a deletion since the last scan) yields no detail, so
      // `v` is a no-op — no modal opens, mirroring how the action seams degrade a
      // vanished target. The frozen `CardDetail` is held on `modal` like the action
      // previews, but `v` does not enter `nav.confirming`: the detail modal is a
      // read-only viewer whose own input branch (below) closes it, like the help
      // modal — there is nothing to confirm.
      if (!detailReader || !selectedPrd) return;
      const zoomed = nav.level === "issues" && selectedIssue !== undefined;
      // One `readDetail` call: an undefined issue id resolves the PRD's `prd.md`,
      // a present one the zoomed Issue's file — no duplicated board-level arm.
      const detail = detailReader.readDetail(
        selectedPrd.id,
        zoomed ? selectedIssue.id : undefined,
      );
      if (detail) {
        setDetailScroll(0); // always open at the top, never a stale position
        // Source the human-review header from the parsed model fields, not the
        // file: the body still comes from `readDetail` (frontmatter stripped, ADR
        // 0014), but the reason + note ride the Issue model the scanner already
        // parsed. Attached only when zoomed on the selected Issue; a PRD's `prd.md`
        // carries neither, so its detail view stays body-only.
        setModal({
          kind: "detail",
          detail: zoomed
            ? {
                ...detail,
                humanReviewReason: selectedIssue.humanReviewReason,
                humanReviewNote: selectedIssue.humanReviewNote,
              }
            : detail,
        });
      }
    },
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

    // The detail modal owns input while it is open, mirroring the help modal's
    // dismissal contract: `v` or Esc close it (restoring the prior selection/zoom,
    // which the modal never touched), `q` closes it and quits. `j`/`k` and the
    // down/up arrows scroll the body, clamped to `[0, detailMaxOffset]` so the
    // offset can never move past the start or end (and a body that fits has
    // `maxOffset` 0, so the keys are inert). Everything else is swallowed (a stray
    // key while reading a body never leaks to the board). It is a read-only viewer,
    // so there is nothing to confirm — it does not go through `nav.confirming`, and
    // closing is just clearing the frozen capture.
    if (modal?.kind === "detail") {
      if (input === "v" || key.escape) {
        setModal(undefined);
      } else if (input === "q") {
        setModal(undefined);
        exit();
      } else if (input === "j" || key.downArrow) {
        setDetailScroll((o) => Math.min(o + 1, detailMaxOffset));
      } else if (input === "k" || key.upArrow) {
        setDetailScroll((o) => Math.max(o - 1, 0));
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
  if (modal?.kind === "detail") {
    // The read-only body view — a full-screen takeover like the action previews
    // (it gives the body the whole screen, ADR 0014), rendered from the frozen
    // capture so a re-scan that removes the card cannot blank it mid-read.
    return (
      <DetailModal
        detail={modal.detail}
        lines={detailLines}
        scrollOffset={detailScroll}
        viewportRows={detailBodyRows}
      />
    );
  }
  // The live board levels share a persistent status line carrying the auto-run
  // indicator. (Modals return above, so the indicator never shows over a preview.)
  // Each lane's available card-row height is the terminal height minus the chrome
  // for the level on screen (the Issue level carries an extra title row); it feeds
  // the columns' vertical scroll window. Recomputed here from the reactive `rows`,
  // so a resize reflows the window for free.
  const view =
    nav.level === "issues" && selectedPrd ? (
      <IssueBoard
        prd={selectedPrd}
        selected={issueSel}
        laneHeight={laneHeight(rows, "issues")}
      />
    ) : (
      <BoardView
        board={board}
        selected={boardSel}
        laneHeight={laneHeight(rows, "board")}
      />
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
