import React from "react";
import { Box, Text } from "ink";
import { Card } from "./Card.js";
import { visibleWindow } from "./viewport.js";
import type { ReadyFor, HumanReviewReason, Liveness, LinkedPr } from "../model.js";

/** The minimal shape both a PRD and an Issue satisfy as a kanban card. */
export interface CardItem {
  readonly id: string;
  readonly title: string;
  readonly readyFor?: ReadyFor;
  readonly humanReviewReason?: HumanReviewReason;
  readonly liveness?: Liveness;
  readonly suppressed?: boolean;
  readonly malformedStatus?: boolean;
  /** The Linked PR overlay, set only on a `done` PRD card (ADR 0013). */
  readonly linkedPr?: LinkedPr;
}

interface ColumnProps {
  heading: string;
  cards: readonly CardItem[];
  /** The id of the card to highlight, if the selected card is in this column. */
  selectedId?: string;
  /**
   * The card-row height this lane has to render in, from the environmental-read
   * hook (terminal rows minus chrome). When set and the lane overflows it, the
   * column renders only the {@link visibleWindow} slice — scrolling to follow the
   * selection (ADR 0015) — instead of stacking every card and clipping the
   * overflow. Absent means no windowing: the whole lane renders (the prior
   * behaviour, kept for unbounded callers and tests that don't drive height).
   */
  availableHeight?: number;
  /**
   * The selected row's index *within this lane*, if the selection is in this
   * column — the anchor the scroll window centres on. Absent (the selection is in
   * another column) windows from the top: a tall unselected lane still shows only
   * its window, so the board never renders every card of every column.
   */
  selectedRow?: number;
}

/**
 * One kanban column: a heading and its cards stacked vertically. When an
 * `availableHeight` is supplied and the lane has more cards than fit, the column
 * renders only the vertical {@link visibleWindow} of its cards, scrolling to keep
 * the selected row in view (ADR 0015) — so a lane taller than the terminal no
 * longer clips unreachable cards. Horizontal overflow is unchanged: the column
 * keeps its fixed width and the row of columns still clips at the screen edge.
 */
export function Column({
  heading,
  cards,
  selectedId,
  availableHeight,
  selectedRow,
}: ColumnProps) {
  // Without a height the column is unbounded — render every card, as before.
  // With one, slice to the visible window, anchored on the selected row (or the
  // lane's top when the selection is elsewhere).
  const visible =
    availableHeight === undefined
      ? cards
      : (() => {
          const { start, end } = visibleWindow(
            availableHeight,
            cards.length,
            selectedRow ?? 0,
          );
          return cards.slice(start, end);
        })();

  return (
    <Box flexDirection="column" width={24} marginRight={1}>
      <Text bold>{heading}</Text>
      {visible.map((card) => (
        <Card
          key={card.id}
          title={card.title}
          readyFor={card.readyFor}
          humanReviewReason={card.humanReviewReason}
          liveness={card.liveness}
          suppressed={card.suppressed}
          malformedStatus={card.malformedStatus}
          linkedPr={card.linkedPr}
          selected={card.id === selectedId}
        />
      ))}
    </Box>
  );
}
