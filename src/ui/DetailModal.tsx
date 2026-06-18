import React from "react";
import { Box, Text } from "ink";
import type { CardDetail } from "./detailReader.js";
import { renderDetailLines } from "./markdown.js";
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

/**
 * The columns the modal spends on horizontal chrome rather than body: the round
 * border (left + right = 2) and the `paddingX={1}` either side (2). The {@link App}
 * subtracts this from the terminal width to get the body's content width, then
 * hard-wraps the rendered lines to it (`renderDetailLines`) so each logical line is
 * one drawn row — the count the scroll window clamps against (issue #71). It lives
 * here beside the layout it measures, like {@link DETAIL_MODAL_CHROME_ROWS}.
 */
export const DETAIL_MODAL_CHROME_COLS = 4;

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
  /**
   * The body's already-rendered terminal lines, supplied by {@link App} so the
   * heavier markdown render runs once per frame (the App also needs the lines to
   * size the scroll window) rather than once here and once there. Omitted by
   * standalone tests, which fall back to rendering `detail.body` directly.
   */
  readonly lines?: readonly string[];
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
export function DetailModal({ detail, scrollOffset = 0, viewportRows, lines }: DetailModalProps) {
  // Use the App-supplied lines when present; otherwise render here (standalone
  // tests, which don't pre-render). `renderDetailLines` returns the same lines the
  // App sizes `maxOffset` from, so the clamp and this window never drift.
  const bodyLines = lines ?? renderDetailLines(detail);
  // "Has content" is decided from the very lines we window — not a second
  // composeDetailMarkdown(detail).trim() pass — so the placeholder branch can't
  // disagree with what renders. `renderDetailLines` already yields `[]` exactly
  // when the composed markdown (header + note + body) renders to nothing, so an
  // empty file body with a note still shows the header, never the placeholder.
  const hasBody = bodyLines.length > 0;
  const rows = viewportRows ?? bodyLines.length;
  const window = scrollDetail(bodyLines, scrollOffset, rows);

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
