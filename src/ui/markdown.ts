import { marked, setOptions, type MarkedOptions } from "marked";
import TerminalRenderer from "marked-terminal";

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
 * Project a body to the rendered terminal lines the detail modal windows: render
 * the markdown, then split on newlines. A blank (or whitespace-only) body yields
 * no lines, so the modal shows its placeholder rather than a single empty line.
 *
 * This is the one place the body→lines transform lives: the {@link App} calls it to
 * size the scroll window's `maxOffset` and the {@link DetailModal} renders the
 * resulting lines, so the clamp and the rendered window operate on the *same* lines
 * (and the heavier `renderMarkdown` runs once per frame, not once per call site).
 */
export function renderDetailLines(body: string): string[] {
  return body.trim().length > 0 ? renderMarkdown(body).split("\n") : [];
}
