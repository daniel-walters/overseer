import React from "react";
import { Box } from "ink";
import { Column } from "./Column.js";
import { groupByLane } from "./lanes.js";
import { LANES, LANE_LABELS } from "../model.js";
import type { Board } from "../model.js";

interface BoardViewProps {
  board: Board;
  /** Index into `board.prds` of the selected PRD, if any. */
  selectedIndex?: number;
}

/** The board-level kanban: PRDs as cards across Unsorted + the five columns. */
export function BoardView({ board, selectedIndex }: BoardViewProps) {
  const byLane = groupByLane(board.prds);
  const selectedId =
    selectedIndex === undefined ? undefined : board.prds[selectedIndex]?.id;

  return (
    <Box flexDirection="row">
      {LANES.map((lane) => (
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
