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
