import React from "react";
import { Box, Text } from "ink";
import { Column } from "./Column.js";
import { groupByLane, cardAtCoord } from "./lanes.js";
import { useColumnWidth } from "./useColumnWidth.js";
import { ISSUE_LANES, LANE_LABELS } from "../model.js";
import type { PRD } from "../model.js";

interface IssueBoardProps {
  /** The PRD whose Issues fill this kanban. */
  prd: PRD;
  /**
   * The selected grid coordinate — `(laneIndex, rowIndex)` over {@link ISSUE_LANES}
   * — if any. The Issue card at that coordinate is highlighted (ADR 0015).
   */
  selected?: { readonly laneIndex: number; readonly rowIndex: number };
  /**
   * The card-row height each lane has to render in, from the environmental-read
   * hook (terminal rows minus chrome, the zoomed title row included). Threaded to
   * every Column so an overflowing lane renders only its visible window and
   * scrolls to follow the selection (ADR 0015). Absent in tests that don't
   * exercise vertical overflow, where the lanes render unbounded as before.
   */
  laneHeight?: number;
}

/**
 * The Issue-level kanban: one PRD's Issues across the seven status columns. There
 * is no Unsorted column — a missing/unknown status folds into Backlog flagged with
 * the `⚠ bad status` marker (CONTEXT.md, ADR 0003).
 */
export function IssueBoard({ prd, selected, laneHeight }: IssueBoardProps) {
  const byLane = groupByLane(prd.issues);
  const selectedId = cardAtCoord(prd.issues, ISSUE_LANES, selected)?.id;
  // The zoomed level divides the viewport across its seven status lanes, so each
  // Issue column is narrower than a board column from the same terminal — and on
  // a standard terminal (7×24 = 168 cells) it holds at the floor and the row
  // clips horizontally at the screen edge (deferred; see columnWidth).
  const width = useColumnWidth(ISSUE_LANES.length);

  return (
    <Box flexDirection="column">
      <Text bold>{prd.title}</Text>
      <Box flexDirection="row">
        {ISSUE_LANES.map((lane, laneIndex) => (
          <Column
            key={lane}
            heading={LANE_LABELS[lane]}
            cards={byLane[lane]}
            selectedId={selectedId}
            width={width}
            availableHeight={laneHeight}
            // Only the selected lane anchors its window on a row; the rest window
            // from the top. The match is on the lane's render-order index, which
            // is exactly what `selected.laneIndex` indexes into (ISSUE_LANES).
            selectedRow={
              selected?.laneIndex === laneIndex ? selected.rowIndex : undefined
            }
          />
        ))}
      </Box>
    </Box>
  );
}
