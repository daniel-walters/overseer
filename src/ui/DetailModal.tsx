import React from "react";
import { Box, Text } from "ink";
import type { CardDetail } from "./detailReader.js";
import { renderMarkdown } from "./markdown.js";
import { scrollDetail } from "./detailScroll.js";

/**
 * The rows the modal spends on chrome rather than body: the round border (top +
 * bottom = 2), the title (1) with its trailing margin (1), the above-affordance
 * row (1), the below-affordance row (1), and the dismiss/scroll hint (1) with its
 * leading margin (1). The {@link App} subtracts this from the terminal height to
 * size the body region it scrolls, so the budget lives in one place beside the
 * layout it describes.
 */
export const DETAIL_MODAL_CHROME_ROWS = 8;

interface DetailModalProps {
  /** The resolved card body to display: its title and frontmatter-stripped body. */
  readonly detail: CardDetail;
  /**
   * The scroll position over the body's *rendered* lines, owned by {@link App}
   * (which clamps it on each `j`/`k`/arrow). Defaults to the top.
   */
  readonly scrollOffset?: number;
  /**
   * How many rows the body region may show. A body taller than this is windowed
   * and gains overflow affordances; a shorter one shows whole. Defaults to
   * unbounded so a body that fits never windows (and tests that don't exercise
   * scrolling render the whole body).
   */
  readonly viewportRows?: number;
}

/**
 * The full-screen detail modal: the selected card's frontmatter-stripped markdown
 * body, opened by `v` (the PRD's `prd.md` at the board level, the selected Issue's
 * file when zoomed). Pure presentation — the open/close/scroll keypress handling
 * lives in {@link App}, mirroring {@link HelpModal}'s dismissal contract; this only
 * renders the {@link CardDetail} a `readDetail` (the detail seam) already resolved,
 * windowed at the scroll offset the App tracks.
 *
 * The body is rendered through {@link renderMarkdown} (marked-terminal, the engine
 * `ink-markdown` wraps — ADR 0014) so headings, lists, and checkboxes display
 * formatted rather than as raw source. The rendered output is split into terminal
 * lines and windowed through {@link scrollDetail}: only the slice that fits
 * `viewportRows` renders, and overflow affordances ("more above"/"more below")
 * signal there is unread content so the user knows to scroll. Scrolling operates on
 * the *rendered* lines, so formatted output scrolls correctly, not the raw source.
 *
 * An empty (or whitespace-only) body shows a quiet placeholder rather than a blank
 * modal — the degenerate case the seam returns as a *defined* result with a blank
 * body. A body that fits the viewport shows no affordance (and the App ignores
 * scroll keys against it, since the offset can't move).
 */
export function DetailModal({ detail, scrollOffset = 0, viewportRows }: DetailModalProps) {
  const hasBody = detail.body.trim().length > 0;
  const lines = hasBody ? renderMarkdown(detail.body).split("\n") : [];
  const rows = viewportRows ?? lines.length;
  const window = scrollDetail(lines, scrollOffset, rows);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{detail.title}</Text>

      <Box marginTop={1} minHeight={1}>
        {window.hasAbove ? (
          <Text dimColor>↑ more above</Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      <Box flexDirection="column">
        {hasBody ? (
          <Text>{window.visible.join("\n")}</Text>
        ) : (
          <Text dimColor italic>
            (no body)
          </Text>
        )}
      </Box>

      <Box minHeight={1}>
        {window.hasBelow ? (
          <Text dimColor>↓ more below</Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>j / k / arrows to scroll · v / Esc to close · q to quit</Text>
      </Box>
    </Box>
  );
}
