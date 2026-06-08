import React from "react";
import { Box, Text } from "ink";
import type { Classification, FrontierEntry } from "../dispatch/frontier.js";

interface DispatchPreviewProps {
  /** The PRD being dispatched, named so the user can catch a wrong target. */
  readonly prdTitle: string;
  /** The computed frontier the dispatch will act on. */
  readonly frontier: readonly FrontierEntry[];
}

/** A frontier section: its heading, the classifications it covers, its colour. */
interface Section {
  readonly heading: string;
  readonly classifications: readonly Classification[];
  readonly color: string;
}

/**
 * The three groups the user reasons about before confirming. `blocked` (the
 * dangling/cyclic fail-safe) is folded into Skipped: from the user's seat both
 * are "not dispatched, and here's why".
 */
const SECTIONS: readonly Section[] = [
  { heading: "Will spawn", classifications: ["spawn"], color: "green" },
  { heading: "Queued (blocked)", classifications: ["queued"], color: "yellow" },
  { heading: "Skipped", classifications: ["skipped", "blocked"], color: "gray" },
];

/**
 * The modal dispatch preview: the pre-spawn plan for one PRD's frontier, split
 * into what will spawn, what is queued, and what is skipped (each with its
 * reason). Pure presentation — the keypress handling and the dispatch itself
 * live in {@link App}; this only renders the plan and the confirm/cancel hint.
 */
export function DispatchPreview({ prdTitle, frontier }: DispatchPreviewProps) {
  const spawnCount = frontier.filter((e) => e.classification === "spawn").length;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Dispatch {prdTitle}</Text>

      {spawnCount === 0 && (
        <Text color="yellow">Nothing is eligible to spawn for this PRD.</Text>
      )}

      {SECTIONS.map((section) => {
        const entries = frontier.filter((e) =>
          section.classifications.includes(e.classification),
        );
        if (entries.length === 0) return null;
        return (
          <Box key={section.heading} flexDirection="column" marginTop={1}>
            <Text bold color={section.color}>
              {section.heading} ({entries.length})
            </Text>
            {entries.map((e) => (
              <Text key={e.issue.id}>
                {"  "}
                {e.issue.id}
                {e.reason ? <Text color="gray"> — {e.reason}</Text> : null}
              </Text>
            ))}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>Enter / y to dispatch · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
