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

/**
 * The board-level kanban: PRDs as cards across the shared {@link LANES}.
 *
 * NOTE: per ADR-0003 the board level should collapse to just backlog /
 * in-progress / done (a PRD has no Unsorted, ready, or review states). That
 * derivation isn't built yet, so this currently reuses the full Issue-level
 * lane set — the extra columns render empty for PRDs until the collapse lands.
 */
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
