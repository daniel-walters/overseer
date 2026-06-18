/**
 * The single keybind registry — the source of truth both the {@link App} input
 * handler and the {@link HelpModal} read, so the two can never drift. Each entry
 * carries the metadata the help modal renders (`key`, `label`, `level`) plus the
 * `action` the input handler dispatches off. Lifting these out of the two former
 * hand-maintained copies makes "the help lists every implemented keybind" a
 * structural fact, not a property a guard test had to assert.
 */

import type { Level, MoveDir } from "./navigation.js";
import type { BindContext } from "./eligibility.js";

/**
 * A binding's level gate: a single nav {@link Level} (`board` / `issues`), or
 * `both` (works at either). Built on the reducer's own `Level` rather than a
 * second copy, so the level vocabulary stays single-sourced — the same single-
 * source-of-truth discipline this registry brings to the keybinds themselves.
 */
export type BindLevel = Level | "both";

/**
 * A keypress as Ink's `useInput` hands it over: the typed character plus the
 * subset of key flags the registry gates on. The matcher reads only these, so a
 * binding is identified the same way the input handler would have with an inline
 * `if`.
 */
export interface KeyPress {
  readonly input: string;
  readonly key: {
    readonly return: boolean;
    readonly escape: boolean;
    readonly upArrow: boolean;
    readonly downArrow: boolean;
    readonly leftArrow: boolean;
    readonly rightArrow: boolean;
  };
}

/**
 * The App-side closures a binding's action invokes. The registry holds no App
 * state itself — it routes a matched key to one of these handlers, which the App
 * wires to its reducer/seams. This keeps the registry pure and testable: a test
 * passes spies and asserts the right one fired.
 *
 * - `move` steps the selection one square in a spatial direction (movement keys derive it).
 * - `zoom` / `back` drive the level reducer (Enter zooms in, Esc backs out).
 * - `dispatch` / `review` / `redispatch` / `kill` / `openPr` / `deletePrd` open the matching preview.
 * - `goToPr` opens the selected `done` PRD's linked PR in the browser.
 * - `toggleAutoRun` flips the global auto-run brake.
 * - `viewDetail` opens the selected card's body in the detail modal.
 * - `showHelp` opens the keybind reference; `quit` backs out or exits.
 */
export interface KeybindHandlers {
  readonly move: (dir: MoveDir) => void;
  readonly zoom: () => void;
  readonly back: () => void;
  readonly dispatch: () => void;
  readonly review: () => void;
  readonly redispatch: () => void;
  readonly kill: () => void;
  readonly openPr: () => void;
  readonly deletePrd: () => void;
  readonly goToPr: () => void;
  readonly toggleAutoRun: () => void;
  readonly viewDetail: () => void;
  readonly showHelp: () => void;
  readonly quit: () => void;
}

/** One registry entry: the metadata both consumers read, plus the action. */
export interface Keybind {
  /** The key label, exactly as the help modal renders it. */
  readonly key: string;
  /** What the key does, as the help modal renders it. */
  readonly label: string;
  /** Where the key works: `board`, `issues`, or `both`. */
  readonly level: BindLevel;
  /**
   * Whether the pressed key (and flags) selects this binding. Movement folds
   * arrows + `hjkl` into one entry, so the predicate — not a bare equality —
   * decides the match.
   */
  readonly matches: (press: KeyPress) => boolean;
  /** Run the binding against the App's wired handlers (and the live keypress). */
  readonly action: (handlers: KeybindHandlers, press: KeyPress) => void;
  /**
   * Whether the binding is eligible for the current selection, read off the
   * App-computed {@link BindContext} (ADR 0017). A binding with **no** `eligible`
   * is always eligible (movement, `Enter`, `Esc`, `a`, `?`, `q`); one that defines
   * it is **inert** — not matched, so the key does nothing — when the predicate
   * fails. The predicate only reads the flag bag; it reaches no seam itself, so the
   * registry stays a pure router and the seam-dependent facts are computed in the
   * App.
   */
  readonly eligible?: (ctx: BindContext) => boolean;
  /**
   * An optional context-aware label override consulted by the **status-line hints
   * only** (ADR 0017). When present, the bar renders `labelFor(ctx)` in place of the
   * static {@link label}; the `?` help map ignores it and always shows {@link label},
   * because help has no live selection to key a dynamic label off (the deliberate
   * eligibility/learning exception). Only `d` defines it — its hint reads "dispatch"
   * on a `backlog` PRD (first ignition) and "resume" on an `in-progress` one (the
   * manual resume crank when auto-run is off). Every other binding keeps its plain
   * static label, so this is the lone dynamic label on the bar. Read via the
   * {@link hintLabel} selector, never directly, so the static-fallback rule is
   * applied in one place.
   */
  readonly labelFor?: (ctx: BindContext) => string;
  /**
   * Whether the binding surfaces on the **status-line hints** (the bottom bar) when
   * eligible. The bar is a curated signal of the *actionable* keys for the current
   * selection — the per-card action keys (`d` / `P` / `go to PR` / `X` / `r` / `R` /
   * `K`) plus the always-on `?` learning pointer — not the whole map, so the
   * navigation keys (movement / `Enter` / `Esc` / `a` / `q` / `v`) carry no `hint`
   * and stay in `?` help only. Eligibility still gates a hinted key: it shows on the
   * bar exactly when its {@link eligible} predicate passes (ADR 0017). `?` is hinted
   * *and* always-eligible, so it never leaves the bar. Orthogonal to {@link eligible}
   * — "does it show on the bar at all?" vs "is it actionable right now?".
   */
  readonly hint?: boolean;
}

/**
 * Translate a movement keypress into a spatial direction, or `undefined` if the
 * key isn't a movement key. The four `hjkl` keys and the four arrows map onto the
 * four directions, all distinct: ←/`h` left, →/`l` right, ↑/`k` up, ↓/`j` down.
 */
function moveDir(press: KeyPress): MoveDir | undefined {
  const { input, key } = press;
  if (key.leftArrow || input === "h") return "left";
  if (key.rightArrow || input === "l") return "right";
  if (key.upArrow || input === "k") return "up";
  if (key.downArrow || input === "j") return "down";
  return undefined;
}

/**
 * The keybind map. Order matters only for the help modal's rendering and for
 * matching precedence (the first matching entry at the given level wins) —
 * movement is the catch-all, so it can sit anywhere as it never collides with a
 * single-key binding.
 */
export const KEYBINDS: readonly Keybind[] = [
  {
    key: "h j k l / arrows",
    label: "Move selection",
    level: "both",
    matches: (p) => moveDir(p) !== undefined,
    action: (h, p) => {
      const dir = moveDir(p);
      if (dir) h.move(dir);
    },
  },
  {
    key: "Enter",
    label: "Zoom into a PRD's Issues",
    level: "board",
    matches: (p) => p.key.return,
    action: (h) => h.zoom(),
  },
  {
    // Once zoomed there is no deeper level to zoom into, so `Enter` aliases `v`
    // at the Issue level: it opens the selected Issue's detail. A second binding
    // gated to `issues` rather than a level-aware action keeps each entry's label
    // and level honest in the `?` help map (board Enter zooms, issue Enter views).
    // Eligibility mirrors `v` — inert when no card is selected.
    key: "Enter",
    label: "View the selected Issue's body",
    level: "issues",
    matches: (p) => p.key.return,
    eligible: (ctx) => ctx.cardSelected,
    action: (h) => h.viewDetail(),
  },
  {
    key: "Esc",
    label: "Back out to the board",
    level: "issues",
    matches: (p) => p.key.escape,
    action: (h) => h.back(),
  },
  {
    key: "d",
    label: "Dispatch a wave",
    level: "board",
    hint: true,
    matches: (p) => p.input === "d",
    // Frontier-based, not lane-based: eligible whenever the selected PRD's
    // frontier has a spawn candidate, so `d` stays available to *resume* an
    // in-progress PRD with newly-unblocked work when auto-run is off (ADR 0017).
    eligible: (ctx) => ctx.dispatchable,
    // The lone dynamic hint label (ADR 0017): "Dispatch a wave" on a backlog PRD
    // (first ignition) vs "Resume a wave" on an in-progress one (re-dispatching
    // newly-unblocked work — the manual crank when auto-run is off). Keys off the
    // PRD's derived *lane*, not the frontier-based `dispatchable` gate. Hints only;
    // `?` help keeps the static "Dispatch a wave".
    labelFor: (ctx) =>
      ctx.prdLane === "in-progress" ? "Resume a wave" : "Dispatch a wave",
    action: (h) => h.dispatch(),
  },
  {
    key: "P",
    label: "Open a PR for a done PRD",
    level: "board",
    hint: true,
    matches: (p) => p.input === "P",
    // A done PRD with no Linked PR yet — mutually exclusive with `go to PR`.
    eligible: (ctx) => ctx.prdDone && !ctx.prdHasPr,
    action: (h) => h.openPr(),
  },
  {
    key: "X",
    label: "Delete a done PRD",
    level: "board",
    hint: true,
    matches: (p) => p.input === "X",
    eligible: (ctx) => ctx.prdDone,
    action: (h) => h.deletePrd(),
  },
  {
    key: "r",
    label: "Review the selected Issue",
    level: "issues",
    hint: true,
    matches: (p) => p.input === "r",
    eligible: (ctx) => ctx.issueReadyForReview,
    action: (h) => h.review(),
  },
  {
    key: "R",
    label: "Re-dispatch an orphaned Issue",
    level: "issues",
    hint: true,
    matches: (p) => p.input === "R",
    eligible: (ctx) => ctx.issueOrphan,
    action: (h) => h.redispatch(),
  },
  {
    key: "K",
    label: "Stop a live Issue's agent",
    level: "issues",
    hint: true,
    matches: (p) => p.input === "K",
    eligible: (ctx) => ctx.issueLive,
    action: (h) => h.kill(),
  },
  {
    key: "g",
    label: "Go to the selected PRD's PR",
    level: "board",
    hint: true,
    matches: (p) => p.input === "g",
    // A done PRD that already has a Linked PR (open or merged) — mutually
    // exclusive with `P`.
    eligible: (ctx) => ctx.prdDone && ctx.prdHasPr,
    action: (h) => h.goToPr(),
  },
  {
    key: "a",
    label: "Toggle auto-run",
    level: "both",
    matches: (p) => p.input === "a",
    action: (h) => h.toggleAutoRun(),
  },
  {
    key: "v",
    label: "View the selected card's body",
    level: "both",
    matches: (p) => p.input === "v",
    eligible: (ctx) => ctx.cardSelected,
    action: (h) => h.viewDetail(),
  },
  {
    key: "?",
    label: "Show this help",
    level: "both",
    hint: true,
    matches: (p) => p.input === "?",
    action: (h) => h.showHelp(),
  },
  {
    key: "q",
    label: "Quit (backs out first if zoomed)",
    level: "both",
    matches: (p) => p.input === "q",
    action: (h) => h.quit(),
  },
];

/** True if a binding gated to `level` is active at the current nav `at`. */
function levelActive(level: BindLevel, at: Level): boolean {
  return level === "both" || level === at;
}

/** True if the binding is eligible for `ctx`; an absent predicate ⇒ always eligible. */
function eligibleFor(bind: Keybind, ctx: BindContext): boolean {
  return bind.eligible === undefined || bind.eligible(ctx);
}

/**
 * Find the binding the keypress selects at the current nav level for the current
 * selection, or `undefined` if none. The first entry whose `matches` fires, whose
 * level gate is open, **and** whose `eligible` predicate passes for `ctx` wins.
 * An ineligible key falls through to no match and is therefore genuinely **inert**
 * — pressing it does nothing because nothing is bound, not because a handler
 * silently no-ops (ADR 0017). Bindings with no predicate are always eligible, so
 * movement / `Enter` / `Esc` / `a` / `?` / `q` match regardless of selection.
 */
export function matchKeybind(
  press: KeyPress,
  at: Level,
  ctx: BindContext,
): Keybind | undefined {
  return KEYBINDS.find(
    (b) => levelActive(b.level, at) && b.matches(press) && eligibleFor(b, ctx),
  );
}

/**
 * The status-line hints for the current nav level + selection: the bottom bar's
 * curated subset of {@link KEYBINDS}, filtered by eligibility (ADR 0017). A binding
 * surfaces here iff it opts in via {@link Keybind.hint}, its level gate is open at
 * `at`, **and** its `eligible` predicate passes for `ctx` — the *same* predicate the
 * matcher gates on, so "does it work?" and "does it show?" can never drift. So the
 * bar offers exactly the keys actionable on the selected card right now (the per-card
 * action keys appear and vanish as the selection moves), plus the always-on `?`.
 *
 * Deliberately the inverse of the `?` help map, which lists *every* key ignoring
 * eligibility: the hints answer "what can I do now?", help answers "what keys exist?".
 * Returns whole bindings (not just labels) so the bar reads each one's `key`/`label`
 * from the single registry — finally retiring the hardcoded `KEY_HINTS` copy.
 */
export function hintsFor(at: Level, ctx: BindContext): readonly Keybind[] {
  return KEYBINDS.filter(
    (b) => b.hint === true && levelActive(b.level, at) && eligibleFor(b, ctx),
  );
}

/**
 * The label the **status-line hints** render for a binding under `ctx`: the
 * binding's context-aware {@link Keybind.labelFor} override when it defines one,
 * otherwise its plain static {@link Keybind.label} (ADR 0017). The single place the
 * static-fallback rule lives, so the bar never reaches `labelFor` directly. The `?`
 * help map does **not** call this — it always renders the static `label`, the
 * deliberate exception (help has no live selection to key a dynamic label off). Only
 * `d` carries a `labelFor` (dispatch vs resume by the PRD's lane); for every other
 * binding this returns the static label unchanged.
 */
export function hintLabel(bind: Keybind, ctx: BindContext): string {
  return bind.labelFor?.(ctx) ?? bind.label;
}
