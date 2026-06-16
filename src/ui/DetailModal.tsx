import React from "react";
import { Box, Text } from "ink";
import type { CardDetail } from "./detailReader.js";
import { renderMarkdown } from "./markdown.js";

interface DetailModalProps {
  /** The resolved card body to display: its title and frontmatter-stripped body. */
  readonly detail: CardDetail;
}

/**
 * The full-screen detail modal: the selected card's frontmatter-stripped markdown
 * body, opened by `v` (the PRD's `prd.md` at the board level, the selected Issue's
 * file when zoomed). Pure presentation — the open/close keypress handling lives in
 * {@link App}, mirroring {@link HelpModal}'s dismissal contract; this only renders
 * the {@link CardDetail} a `readDetail` (the detail seam) already resolved.
 *
 * The body is rendered through {@link renderMarkdown} (marked-terminal, the engine
 * `ink-markdown` wraps — ADR 0014) so headings, lists, and checkboxes display
 * formatted rather than as raw source, then dropped into a single Ink `<Text>` (the
 * shape `ink-markdown` itself returns). An empty (or whitespace-only) body shows a
 * quiet placeholder rather than a blank modal — the degenerate case the seam returns
 * as a *defined* result with a blank body.
 *
 * This slice renders a body that fits the screen; windowing a long body for
 * scrolling is the next slice (003).
 */
export function DetailModal({ detail }: DetailModalProps) {
  const hasBody = detail.body.trim().length > 0;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{detail.title}</Text>

      <Box marginTop={1}>
        {hasBody ? (
          <Text>{renderMarkdown(detail.body)}</Text>
        ) : (
          <Text dimColor italic>
            (no body)
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>v / Esc to close · q to quit</Text>
      </Box>
    </Box>
  );
}
