import React from "react";
import { Box, Text } from "ink";
import type { ReadyFor } from "../model.js";

interface CardProps {
  title: string;
  /** Routing badge, present only while the card is in the ready column. */
  readyFor?: ReadyFor;
}

const BADGE: Record<ReadyFor, string> = {
  human: "🧑",
  agent: "🤖",
};

/** A single kanban card. At board level the card is a PRD. */
export function Card({ title, readyFor }: CardProps) {
  return (
    <Box borderStyle="round" paddingX={1} width="100%">
      <Text wrap="truncate-end">
        {readyFor ? `${BADGE[readyFor]} ` : ""}
        {title}
      </Text>
    </Box>
  );
}
