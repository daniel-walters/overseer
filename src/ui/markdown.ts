import { marked, setOptions, type MarkedOptions } from "marked";
import TerminalRenderer from "marked-terminal";
import type { CardDetail } from "./detailReader.js";
import { REASON_MARKER } from "./Card.js";

/**
 * Render a markdown body to terminal text (ANSI styling for headings, list
 * bullets, checkboxes) — the presentation transform behind the detail modal.
 *
 * ADR 0014 calls for rendering through `marked-terminal`, the engine the
 * `ink-markdown` component wraps. `ink-markdown` itself is published as a
 * CommonJS shim that `require()`s the ESM-only `ink`, which fails under this
 * project's pure-ESM + `ink@7` setup (`ERR_REQUIRE_ASYNC_MODULE`). So this module
 * does exactly what `ink-markdown` does — point `marked` at a `TerminalRenderer`
 * and parse — but importing `marked` / `marked-terminal` directly, the two deps
 * `ink-markdown` would have pulled in. The result is wrapped in a single Ink
 * `<Text>` by {@link DetailModal}, mirroring `ink-markdown`'s own one-line body.
 *
 * The dependency stays contained behind the modal (nothing else imports this),
 * so it remains reversible at low cost exactly as ADR 0014 intends.
 */
export function renderMarkdown(body: string): string {
  // `marked-terminal`'s renderer satisfies marked's renderer contract at runtime
  // but is typed against its own copy of marked, so it needs a structural cast —
  // the same loose coupling `ink-markdown` relies on by being untyped JS.
  setOptions({ renderer: new TerminalRenderer() as unknown as MarkedOptions["renderer"] });
  return (marked.parse(body) as string).trim();
}

/**
 * Compose the markdown the detail modal renders for a card: the reviewer's
 * human-review header (the escalation reason as a heading, the note beneath it)
 * prepended to the frontmatter-stripped body. The header renders **only** for a
 * `human-review` Issue carrying both a reason and a non-blank note (the App sets
 * those from the parsed model fields — ADR 0014); a PRD's `prd.md` and every
 * other Issue compose to the body alone, so their detail view is unchanged.
 *
 * The header is plain markdown folded into the same string as the body, so it
 * flows through one render and one scroll window — the note scrolls like the body
 * (a multi-sentence explanation stays fully readable, never card-truncated)
 * rather than being pinned chrome that would need its own viewport accounting.
 * The heading text is `Card.tsx`'s {@link REASON_MARKER}, so the detail header and
 * the card marker read as the same signal.
 */
export function composeDetailMarkdown(detail: CardDetail): string {
  const note = detail.humanReviewNote?.trim();
  if (detail.humanReviewReason === undefined || !note) return detail.body;
  const header = `## ${REASON_MARKER[detail.humanReviewReason]}\n\n${note}`;
  // A blank body would otherwise leave a trailing separator with nothing under
  // it; join only the present parts so the header stands alone when the Issue
  // file has frontmatter but no body.
  return detail.body.trim().length > 0 ? `${header}\n\n---\n\n${detail.body}` : header;
}

/**
 * Project a {@link CardDetail} to the rendered terminal lines the detail modal
 * windows: compose the header+body markdown, render it, then split on newlines. A
 * card that composes to a blank (or whitespace-only) string yields no lines, so
 * the modal shows its placeholder rather than a single empty line.
 *
 * This is the one place the detail→lines transform lives: the {@link App} calls it
 * to size the scroll window's `maxOffset` and the {@link DetailModal} renders the
 * resulting lines, so the clamp and the rendered window operate on the *same* lines
 * (and the heavier `renderMarkdown` runs once per frame, not once per call site).
 */
export function renderDetailLines(detail: CardDetail): string[] {
  const markdown = composeDetailMarkdown(detail);
  return markdown.trim().length > 0 ? renderMarkdown(markdown).split("\n") : [];
}
