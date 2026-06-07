import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor } from "../model.js";

interface CardProps {
  title: string;
  /** Routing badge, present only while the card is in the ready column. */
  readyFor?: ReadyFor;
  /** Whether this card is the current selection. */
  selected?: boolean;
}

const BADGE: Record<ReadyFor, string> = {
  human: "🧑",
  agent: "🤖",
};

/** A single kanban card. At board level it is a PRD; when zoomed, an Issue. */
export function Card({ title, readyFor, selected = false }: CardProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={selected ? "cyan" : undefined}
      paddingX={1}
      width="100%"
    >
      <Text wrap="truncate-end" inverse={selected} bold={selected}>
        {selected ? "▶ " : ""}
        {readyFor ? `${BADGE[readyFor]} ` : ""}
        {title}
      </Text>
    </Box>
  );
}
