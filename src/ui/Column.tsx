import React from "react";
import { Box, Text } from "ink";
import { Card } from "./Card.js";
import type { PRD } from "../model.js";

interface ColumnProps {
  heading: string;
  cards: readonly PRD[];
}

/** One kanban column: a heading and its cards stacked vertically. */
export function Column({ heading, cards }: ColumnProps) {
  return (
    <Box flexDirection="column" width={24} marginRight={1}>
      <Text bold>{heading}</Text>
      {cards.map((prd) => (
        <Card key={prd.id} title={prd.title} readyFor={prd.readyFor} />
      ))}
    </Box>
  );
}
