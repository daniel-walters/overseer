# 2-D navigation with vertical-only selection-following scroll

## Status

accepted

## Context

Navigation is **fake 2-D**. `navReduce` models selection as a single flat index per
level (`boardIndex` / `issueIndex`) and a `move` action carrying a signed `delta`
over a flat `count`. All four movement keys collapse into ±1 over that flat list:
`h`/`k` both move −1, `j`/`l` both move +1. So `h` and `k` are indistinguishable, `j`
and `l` are indistinguishable, and `l` does **not** move right to the next column — it
steps to the next card in the scanner's flat order. A user pressing `l` on a kanban
board expects to move to the column on the right; today it doesn't.

The flat index also cannot be *made* to mean "next column" cheaply, because the flat
order and the visual grid are disconnected: the renderer groups the flat card list
into lanes (`groupByLane`) at render time, so card N in scanner order can land in any
lane. The reducer has no idea which lane the selected card sits in.

Compounding this, the board renders **full screen on the alternate screen buffer**
(ADR 0001 / CONTEXT.md) which has **no scrollback**: a lane with more cards than the
terminal is tall **clips** the overflow, and there is no scroll and no scrollback to
reach the hidden cards. On a small terminal, cards become genuinely unreachable.

These two problems are coupled. Making navigation truly 2-D requires the reducer to
know the selection's grid position, and once it does, the viewport can scroll to keep
the selected card visible — which is exactly the fix for the unreachable-cards
problem. So they are designed together.

The open scope question is **which overflow axes** to solve. There are two: vertical
(a lane taller than the screen) and horizontal (the 7-column Issue level wider than a
normal terminal, made more acute by the adaptive column width that floors columns at
24). Solving both means paging whole columns in and out of a fixed-width viewport —
substantially more work — while the vertical case is the actual "hidden cards with no
recourse" complaint users hit.

## Decision

Selection becomes a **2-D `(laneIndex, rowIndex)` coordinate** per level, and the
viewport scrolls **vertically** to follow it. Horizontal column overflow is **left
clipped and deliberately deferred.**

- **2-D selection model.** `NavState` tracks the selected lane and the row within it.
  `h`/`l` change lane; `j`/`k` change row. The reducer stays pure: it receives the
  **lane shape** (per-lane card counts) as `move` action data, the way it receives
  `count` today. The renderer selects by coordinate, not by a flat-index-derived id.
- **Sticky row.** The reducer keeps a remembered `desiredRow` alongside the live
  `rowIndex`. `j`/`k` set both; `h`/`l` clamp `rowIndex` from `desiredRow` against the
  target lane's height — so a tall → short → tall lane round-trip returns to the
  original row rather than the clamped one.
- **Skip empty lanes.** `h`/`l` move to the next *non-empty* lane, so selection always
  rests on a card (preserving the "something is always selected" invariant the whole
  app assumes). If every other lane is empty, `h`/`l` are no-ops.
- **Vertical selection-following scroll.** Each lane renders a *window* of its cards;
  moving the selection past the window edge scrolls the window to keep the selected
  card visible (scrolloff-style). A pure `visibleWindow(laneHeight, cardCount,
  selectedRow)` function computes the visible slice; the available lane height comes
  from a thin environmental-read hook (terminal rows minus chrome), the vertical twin
  of the adaptive-width hook.
- **Horizontal overflow stays clipped.** When columns at their floor exceed the
  terminal width, the row clips at the screen edge as it does today. Horizontal
  scrolling / column paging is a logged follow-on, not built here.

Arrow keys map onto the same model for free (←/→ → `h`/`l`, ↑/↓ → `j`/`k`).

## Consequences

- **`l` finally moves right.** The single most surprising stranger-facing
  wrong-behavior (pressing `l` and not moving to the next column) is fixed, and the
  four movement keys become distinct. This is the higher-frequency bug a new user hits
  before they ever hit overflow.
- **Every card becomes reachable.** Because selecting a card scrolls it into view, the
  vertical no-scrollback clipping no longer hides cards with no recourse — the original
  complaint is resolved through navigation rather than a separate scroll gesture.
- **The asymmetry is deliberate, recorded so it is not "fixed" by accident.** Vertical
  overflow scrolls; horizontal overflow still clips. A future reader will see a
  half-solved viewport and may try to "complete" it — this records that horizontal
  column-paging on a fixed-width alt screen is a genuinely larger problem and a rarer
  pain, consciously deferred, not forgotten. The vertical case carries the real
  unreachable-cards complaint; the horizontal case is a wide-terminal-only annoyance.
- **The reducer stays pure; geometry lives in seams.** The model receives lane shape
  and height as data, and the only non-trivial logic (cross-lane clamping, the visible
  window) is pure functions tested in isolation — consistent with the codebase's
  deep-module discipline. Lane height (chrome subtraction) is the one fiddly,
  environment-coupled piece and is confined to the Ink hook, kept out of the pure
  functions.
- **Both levels covered by one change.** The 3-column board and 7-column Issue level
  are both grids, so the 2-D reducer serves both — the change is made once.
- **Shared environmental-read seam with adaptive width.** The hook reading terminal
  *width* for the column-width work also reads terminal *height* for the window
  function; one environmental-read seam serves both. This couples the work to the
  `title-legibility` PRD's width hook — an overlap to coordinate, not a hard blocker.
