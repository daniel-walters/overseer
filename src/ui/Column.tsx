import React from "react";
import { Box, Text } from "ink";
import { Card } from "./Card.js";
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
}

/** One kanban column: a heading and its cards stacked vertically. */
export function Column({ heading, cards, selectedId }: ColumnProps) {
  return (
    <Box flexDirection="column" width={24} marginRight={1}>
      <Text bold>{heading}</Text>
      {cards.map((card) => (
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
