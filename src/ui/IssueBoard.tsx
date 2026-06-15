import React from "react";
import { Box, Text } from "ink";
import { Column } from "./Column.js";
import { groupByLane } from "./lanes.js";
import { ISSUE_LANES, LANE_LABELS } from "../model.js";
import type { PRD } from "../model.js";

interface IssueBoardProps {
  /** The PRD whose Issues fill this kanban. */
  prd: PRD;
  /** Index into `prd.issues` of the selected Issue. */
  selectedIndex: number;
}

/**
 * The Issue-level kanban: one PRD's Issues across the seven status columns. There
 * is no Unsorted column — a missing/unknown status folds into Backlog flagged with
 * the `⚠ bad status` marker (CONTEXT.md, ADR 0003).
 */
export function IssueBoard({ prd, selectedIndex }: IssueBoardProps) {
  const byLane = groupByLane(prd.issues);
  const selectedId = prd.issues[selectedIndex]?.id;

  return (
    <Box flexDirection="column">
      <Text bold>{prd.title}</Text>
      <Box flexDirection="row">
        {ISSUE_LANES.map((lane) => (
          <Column
            key={lane}
            heading={LANE_LABELS[lane]}
            cards={byLane[lane]}
            selectedId={selectedId}
          />
        ))}
      </Box>
    </Box>
  );
}
