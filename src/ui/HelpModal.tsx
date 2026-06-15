import React from "react";
import { Box, Text } from "ink";
import { KEYBINDS } from "./keybinds.js";

/**
 * The modal keybind reference, opened by `?` and dismissed by `?`/`Esc` (or `q`,
 * which also quits). Pure presentation — the open/close keypress handling lives in
 * {@link App}; this only renders the map and the dismiss hint.
 *
 * Its rows come straight from the central {@link KEYBINDS} registry — the same
 * source the App input handler dispatches off — so the help screen can no longer
 * drift from the real bindings. It lists *every* key with its context (board /
 * issues / both) rather than filtering to the current level: a user pressing `?`
 * wants the whole map, including keys that only light up once zoomed in.
 */
export function HelpModal() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keybindings</Text>

      <Box flexDirection="column" marginTop={1}>
        {KEYBINDS.map((b) => (
          <Text key={`${b.key}@${b.level}`}>
            <Text bold>{b.key}</Text>
            {"  "}
            {b.label}
            <Text color="gray"> ({b.level})</Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>? / Esc to close · q to quit</Text>
      </Box>
    </Box>
  );
}
