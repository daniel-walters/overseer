import React from "react";
import { Box, Text } from "ink";
import { Card } from "./Card.js";
import type { ReadyFor } from "../model.js";

/** The minimal shape both a PRD and an Issue satisfy as a kanban card. */
export interface CardItem {
  readonly id: string;
  readonly title: string;
  readonly readyFor?: ReadyFor;
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
          selected={card.id === selectedId}
        />
      ))}
    </Box>
  );
}
