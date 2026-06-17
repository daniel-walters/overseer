import React from "react";
import { Box } from "ink";
import { Column } from "./Column.js";
import { groupByLane, cardAtCoord } from "./lanes.js";
import { useColumnWidth } from "./useColumnWidth.js";
import { BOARD_LANES, LANE_LABELS } from "../model.js";
import type { Board } from "../model.js";

interface BoardViewProps {
  board: Board;
  /**
   * The selected grid coordinate — `(laneIndex, rowIndex)` over {@link BOARD_LANES}
   * — if any. The PRD card at that coordinate is highlighted (ADR 0015).
   */
  selected?: { readonly laneIndex: number; readonly rowIndex: number };
  /**
   * The card-row height each lane has to render in, from the environmental-read
   * hook (terminal rows minus chrome). Threaded to every Column so an overflowing
   * lane renders only its visible window and scrolls to follow the selection
   * (ADR 0015). Absent in tests that don't exercise vertical overflow, where the
   * lanes render unbounded as before.
   */
  laneHeight?: number;
}

/**
 * The board-level kanban: PRDs as cards across the three {@link BOARD_LANES}
 * (backlog / in-progress / done). A PRD has no stored status — the scanner
 * derives its lane from its Issues — so this level has no Unsorted, ready, or
 * review columns (ADR 0003).
 */
export function BoardView({ board, selected, laneHeight }: BoardViewProps) {
  const byLane = groupByLane(board.prds);
  const selectedId = cardAtCoord(board.prds, BOARD_LANES, selected)?.id;
  // The board level divides the viewport across its three lanes (vs the Issue
  // level's seven), so the same terminal gives PRD columns generous room here.
  const width = useColumnWidth(BOARD_LANES.length);

  return (
    <Box flexDirection="row">
      {BOARD_LANES.map((lane, laneIndex) => (
        <Column
          key={lane}
          heading={LANE_LABELS[lane]}
          cards={byLane[lane]}
          selectedId={selectedId}
          width={width}
          availableHeight={laneHeight}
          // Only the lane the selection sits in anchors its window on a row; the
          // others window from the top. Matching by the lane's render-order index
          // is exactly how `selected.laneIndex` is defined (an index into
          // BOARD_LANES), so this targets the right column.
          selectedRow={
            selected?.laneIndex === laneIndex ? selected.rowIndex : undefined
          }
        />
      ))}
    </Box>
  );
}
