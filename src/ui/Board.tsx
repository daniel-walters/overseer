import React from "react";
import { Box } from "ink";
import { Column } from "./Column.js";
import { LANES, LANE_LABELS } from "../model.js";
import type { Board, PRD, Lane } from "../model.js";

interface BoardViewProps {
  board: Board;
}

/** The board-level kanban: PRDs as cards across Unsorted + the five columns. */
export function BoardView({ board }: BoardViewProps) {
  const byLane = groupByLane(board.prds);

  return (
    <Box flexDirection="row">
      {LANES.map((lane) => (
        <Column
          key={lane}
          heading={LANE_LABELS[lane]}
          cards={byLane[lane]}
        />
      ))}
    </Box>
  );
}

/** Bucket PRDs into their lanes, preserving the order the scanner produced. */
function groupByLane(prds: readonly PRD[]): Record<Lane, PRD[]> {
  const byLane = Object.fromEntries(
    LANES.map((lane) => [lane, [] as PRD[]]),
  ) as Record<Lane, PRD[]>;

  for (const prd of prds) {
    byLane[prd.lane].push(prd);
  }
  return byLane;
}
