import React from "react";
import { Box, Text } from "ink";

/** One keybind row: the key, what it does, and where it works. */
interface Binding {
  readonly key: string;
  readonly action: string;
  readonly context: string;
}

/**
 * The full keybind map, listed with each key's context (board / issues / both).
 * A static reference card — the help modal is pure reference, so it lists *every*
 * key rather than filtering to the current level (a user pressing `?` wants the
 * whole map, including keys that only light up once zoomed in).
 *
 * This is a second, hand-maintained copy of the bindings the {@link App} input
 * handler implements; the "lists every implemented keybind" test guards it against
 * drift. A central keybind registry is a logged follow-up (docs/ideas.md).
 */
const BINDINGS: readonly Binding[] = [
  { key: "h j k l / arrows", action: "Move selection", context: "both" },
  { key: "Enter", action: "Zoom into a PRD's Issues", context: "board" },
  { key: "Esc", action: "Back out to the board", context: "issues" },
  { key: "d", action: "Dispatch a wave", context: "board" },
  { key: "r", action: "Review the selected Issue", context: "issues" },
  { key: "R", action: "Re-dispatch an orphaned Issue", context: "issues" },
  { key: "a", action: "Toggle auto-run", context: "both" },
  { key: "?", action: "Show this help", context: "both" },
  { key: "q", action: "Quit (backs out first if zoomed)", context: "both" },
];

/**
 * The modal keybind reference, opened by `?` and dismissed by `?`/`Esc` (or `q`,
 * which also quits). Pure presentation — the open/close keypress handling lives in
 * {@link App}; this only renders the map and the dismiss hint.
 */
export function HelpModal() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keybindings</Text>

      <Box flexDirection="column" marginTop={1}>
        {BINDINGS.map((b) => (
          <Text key={b.key}>
            <Text bold>{b.key}</Text>
            {"  "}
            {b.action}
            <Text color="gray"> ({b.context})</Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>? / Esc to close · q to quit</Text>
      </Box>
    </Box>
  );
}
