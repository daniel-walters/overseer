# 0015 — 2-D spatial navigation with vertical selection-following scroll

## Status

Accepted

## Context

The board is a kanban, but it did not navigate like one. Selection was a single flat
index per level (`boardIndex` / `issueIndex`) and `move` carried a 1-D `delta` over a
flat `count`. The renderer grouped that flat list into lanes only at render time
(`groupByLane`), so the reducer had no idea which lane the selection sat in. The four
`hjkl` movement keys collapsed onto that one axis: `h`/`k` both stepped −1 and `j`/`l`
both stepped +1, so `h` and `k` were indistinguishable, `j` and `l` were
indistinguishable, and `l` did **not** move to the column on the right — it stepped to
the next card in the scanner's flat order. A first-time user presses `l` expecting to
move right, and it doesn't: the most surprising wrong-behaviour a stranger hits.

The two problems are coupled. The reason `l` can't mean "next column" is that selection
is a flat index disconnected from the visual grid. Fix that — make selection a real grid
coordinate — and the viewport can then scroll vertically to keep the selected card
visible, which is what makes every card reachable on a small terminal (the alt screen
has no scrollback, ADR 0001, so a clipped lane is genuinely unreachable today).

## Decision

**Selection is a 2-D `(laneIndex, rowIndex)` coordinate per level.** `h`/`l` change the
lane; `j`/`k` change the row. Both the 3-column board level and the 7-column Issue level
are grids, so one coordinate model and one reducer change serve both.

**The reducer stays pure.** The `move` action receives the **lane shape** — the per-lane
card counts — as plain data, exactly the way it received `count` before. The reducer
imports neither Ink nor the Board. The renderer selects the card by `(lane, row)`
coordinate instead of by a flat-index-derived id.

**Sticky row.** A remembered `desiredRow` rides alongside the live `rowIndex`. `j`/`k`
set both; `h`/`l` clamp `rowIndex` from `desiredRow` against the target lane's height. A
tall → short → tall round-trip therefore returns to the original row, not the clamped
one.

**Skip empty lanes.** `h`/`l` move to the next *non-empty* lane, so selection always
rests on a card — preserving the "something is always selected" invariant the whole app
relies on (`selectedId`, every action handler). No null-selection state is introduced.
If every other lane is empty, `h`/`l` are no-ops. The `desiredRow` governs the landing
row in the lane skipped *to*.

**Arrow keys mirror `hjkl`** — ←/→ are `h`/`l`, ↑/↓ are `j`/`k`.

**Vertical-only selection-following scroll (deferred to slice 002).** A lane taller than
the screen will render a *window* of its cards, scrolling to keep the selection visible.
That is the next slice; this ADR records the asymmetry it introduces.

**Horizontal overflow stays clipped (deliberate, deferred).** When the column count at
the floor exceeds the terminal width (the 7-column Issue level on a normal terminal), the
row clips at the screen edge as it does today. Horizontal scrolling / column paging is a
logged follow-on, not built — the vertical and horizontal axes are deliberately
asymmetric: vertical scrolls to follow the selection, horizontal clips.

## Consequences

- `NavState` grows from a flat index per level to a `(laneIndex, rowIndex, desiredRow)`
  coordinate per level. The reducer's `move` action takes a `dir` (`"left" | "right" |
  "up" | "down"`) plus the `lanes` shape, replacing the 1-D `delta` + `count`.
- The renderer maps the coordinate to a card id (`byLane[lanes[laneIndex]][rowIndex]`)
  and passes the familiar `selectedId` down to the columns — the Column/Card contract is
  unchanged.
- Because both levels are grids over the same `groupByLane` buckets, the board's three
  lanes and the Issue level's seven lanes share the one reducer and the one mapping.
- The flat-index call sites (`board.prds[boardIndex]`, `prd.issues[issueIndex]`) become
  coordinate lookups; "the selected card" is resolved through the grid, never through
  scanner order.
