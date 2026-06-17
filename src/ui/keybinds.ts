/**
 * The single keybind registry — the source of truth both the {@link App} input
 * handler and the {@link HelpModal} read, so the two can never drift. Each entry
 * carries the metadata the help modal renders (`key`, `label`, `level`) plus the
 * `action` the input handler dispatches off. Lifting these out of the two former
 * hand-maintained copies makes "the help lists every implemented keybind" a
 * structural fact, not a property a guard test had to assert.
 */

import type { Level, MoveDir } from "./navigation.js";

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
    matches: (p) => p.input === "d",
    action: (h) => h.dispatch(),
  },
  {
    key: "P",
    label: "Open a PR for a done PRD",
    level: "board",
    matches: (p) => p.input === "P",
    action: (h) => h.openPr(),
  },
  {
    key: "X",
    label: "Delete a done PRD",
    level: "board",
    matches: (p) => p.input === "X",
    action: (h) => h.deletePrd(),
  },
  {
    key: "r",
    label: "Review the selected Issue",
    level: "issues",
    matches: (p) => p.input === "r",
    action: (h) => h.review(),
  },
  {
    key: "R",
    label: "Re-dispatch an orphaned Issue",
    level: "issues",
    matches: (p) => p.input === "R",
    action: (h) => h.redispatch(),
  },
  {
    key: "K",
    label: "Stop a live Issue's agent",
    level: "issues",
    matches: (p) => p.input === "K",
    action: (h) => h.kill(),
  },
  {
    key: "g",
    label: "Go to the selected PRD's PR",
    level: "board",
    matches: (p) => p.input === "g",
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
    action: (h) => h.viewDetail(),
  },
  {
    key: "?",
    label: "Show this help",
    level: "both",
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

/**
 * Find the binding the keypress selects at the current nav level, or `undefined`
 * if none. The first entry whose `matches` fires and whose level gate is open
 * wins — the same precedence the old inline `if` chain had, now data-driven.
 */
export function matchKeybind(press: KeyPress, at: Level): Keybind | undefined {
  return KEYBINDS.find((b) => levelActive(b.level, at) && b.matches(press));
}
