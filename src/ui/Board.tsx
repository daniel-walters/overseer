import React from "react";
import { Box } from "ink";
import { Column } from "./Column.js";
import { groupByLane, cardAtCoord } from "./lanes.js";
import { BOARD_LANES, LANE_LABELS } from "../model.js";
import type { Board } from "../model.js";

interface BoardViewProps {
  board: Board;
  /**
   * The selected grid coordinate — `(laneIndex, rowIndex)` over {@link BOARD_LANES}
   * — if any. The PRD card at that coordinate is highlighted (ADR 0015).
   */
  selected?: { readonly laneIndex: number; readonly rowIndex: number };
}

/**
 * The board-level kanban: PRDs as cards across the three {@link BOARD_LANES}
 * (backlog / in-progress / done). A PRD has no stored status — the scanner
 * derives its lane from its Issues — so this level has no Unsorted, ready, or
 * review columns (ADR 0003).
 */
export function BoardView({ board, selected }: BoardViewProps) {
  const byLane = groupByLane(board.prds);
  const selectedId = cardAtCoord(board.prds, BOARD_LANES, selected)?.id;

  return (
    <Box flexDirection="row">
      {BOARD_LANES.map((lane) => (
        <Column
          key={lane}
          heading={LANE_LABELS[lane]}
          cards={byLane[lane]}
          selectedId={selectedId}
        />
      ))}
    </Box>
  );
}
