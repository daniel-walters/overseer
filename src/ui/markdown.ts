import { marked, setOptions, type MarkedOptions } from "marked";
import TerminalRenderer from "marked-terminal";
import type { CardDetail } from "./detailReader.js";
import { REASON_MARKER } from "../model.js";

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
 * The heading shown above a human-review note. When the scanner parsed a
 * recognized escalation reason we reuse its {@link REASON_MARKER} so the detail
 * header and the card marker read as the same signal; when the reason is absent
 * or unrecognized — which the scanner tolerates while still landing the note
 * (the note is additive, independent of the reason) — we fall back to a neutral
 * `human-review` heading so the note never gets dropped with the reason.
 */
function headerHeading(reason: CardDetail["humanReviewReason"]): string {
  return reason === undefined ? "⚠ human-review" : REASON_MARKER[reason];
}

/**
 * Escape a reviewer's free-text note so it renders **verbatim** rather than being
 * reinterpreted as markdown. The note routinely quotes agent output — a bare
 * `---` line, an unclosed ``` fence, a leading `#` or `-` — which would otherwise
 * parse as a rule, swallow the real body into a code block, or become a heading,
 * and could collide with the `---` separator the composer inserts. Backslash-
 * escaping the block- and inline-significant characters keeps the prose literal
 * while still flowing through the one render + one scroll window the body uses.
 */
function escapeNoteMarkdown(note: string): string {
  // Backslash-escape every block- and inline-significant character; once each
  // `-`/`_`/`*` in a `---`-style run is escaped, it can no longer read as a
  // thematic break, so a single pass suffices.
  return note.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1");
}

/**
 * Compose the markdown the detail modal renders for a card: the reviewer's
 * human-review header (the escalation reason as a heading, the note beneath it)
 * prepended to the frontmatter-stripped body. The header renders for any card
 * carrying a non-blank `humanReviewNote` (the App sets it from the parsed model
 * field — ADR 0014); the reason only chooses the heading text and may be absent,
 * since the scanner lands the note independently of the reason. A PRD's `prd.md`
 * and every Issue without a note compose to the body alone, so their detail view
 * is unchanged.
 *
 * The header is plain markdown folded into the same string as the body, so it
 * flows through one render and one scroll window — the note scrolls like the body
 * (a multi-sentence explanation stays fully readable, never card-truncated)
 * rather than being pinned chrome that would need its own viewport accounting.
 * The note itself is escaped ({@link escapeNoteMarkdown}) so quoted agent output
 * renders literally and can't collide with the `---` separator.
 */
export function composeDetailMarkdown(detail: CardDetail): string {
  const note = detail.humanReviewNote?.trim();
  if (!note) return detail.body;
  const header = `## ${headerHeading(detail.humanReviewReason)}\n\n${escapeNoteMarkdown(note)}`;
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
