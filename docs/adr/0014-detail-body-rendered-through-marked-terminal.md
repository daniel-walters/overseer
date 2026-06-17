# The detail modal renders its body through marked-terminal (the engine ink-markdown wraps)

## Status

accepted

## Context

The detail modal (the `v` body view) shows a card's frontmatter-stripped markdown body — a PRD's `prd.md` at the board level, the selected Issue's file when zoomed — opened by `v`. The body must be **rendered**, not shown as raw source: a user reading a long PRD body wants headings, list bullets, and checkboxes formatted so the body is scannable (user stories 5, 13). This is the app's **first presentation-only dependency** — every prior dependency (`chokidar`, `gray-matter`, `ink`, `meow`, `smol-toml`) earns its place in the scan/model/render core; a markdown→terminal renderer earns its place only in the viewer.

Three shapes were considered:

1. **Hand-rolled formatting** — a small markdown-ish transform of our own (bold headings, indent lists). No dependency, but it re-implements a solved problem badly and drifts from real markdown the moment a body uses a construct we didn't anticipate.
2. **`ink-markdown`** — the named, purpose-built Ink component that wraps `marked` + `marked-terminal` in a single `<Text>`. The PRD picks this.
3. **`marked` + `marked-terminal` directly** — the exact engine `ink-markdown` itself wraps, imported without the thin Ink shim.

The renderer is **contained behind one modal**: nothing else in the codebase touches markdown rendering, so whichever dependency is chosen is reversible at low cost — the cost is one small module, `markdown.ts`, plus the modal that calls it.

## Decision

The detail modal renders its body through **`marked-terminal`** — the engine `ink-markdown` wraps — driven by `marked`, behind a single contained module (`src/ui/markdown.ts`'s `renderMarkdown`). The result is dropped into one Ink `<Text>` by `DetailModal`, exactly the shape `ink-markdown` itself returns. `renderMarkdown` does precisely what `ink-markdown` does — point `marked` at a `TerminalRenderer` and parse — so the rendering is identical; only the import boundary differs.

We **do not depend on the `ink-markdown` package itself**, despite the PRD naming it, because its published build is incompatible with this project's runtime. `ink-markdown@1.0.4` ships as a CommonJS module that `require()`s its peers, but this project is pure ESM on `ink@7`, whose module graph (via `yoga-layout`) uses top-level `await`. A CommonJS `require()` of such a graph throws `ERR_REQUIRE_ASYNC_MODULE` — the component cannot be imported here at all. `marked` (`^9`, the version `ink-markdown` pins) and `marked-terminal` (`^6`) are both ESM-native and import cleanly, so depending on them directly is the only path that both renders through `marked-terminal` (the PRD's actual intent) and runs.

`@types/marked-terminal` is added as a dev dependency to type the renderer — the same type package `ink-markdown` declared for itself.

## Consequences

- **The rendering is exactly what the PRD specified.** "Rendered through `marked-terminal`" is satisfied to the letter — the same renderer, the same `marked` major, the same one-`<Text>` output. The only thing dropped is a five-line wrapper that does not run in this environment. The deviation is in the *dependency edge*, not the *behaviour*.
- **The dependency stays contained.** `marked` + `marked-terminal` are reachable only through `renderMarkdown`, called only by `DetailModal`. Swapping the renderer (or restoring `ink-markdown` if a future ESM build ships) is a one-module change behind a stable `string → string` seam — the reversibility the PRD asked for is preserved, arguably improved, since we own the seam rather than a third party's `<Text>`.
- **`renderMarkdown` is a deep module behind a trivial interface.** `renderMarkdown(body: string): string` hides the renderer wiring (`setOptions` + `TerminalRenderer` + `parse`) entirely; the modal and its tests never name `marked`. Markdown→ANSI is the library's responsibility and is not re-tested (the tests cover *our* seam, *our* wiring, *our* placeholder — not the transform), so the contained interface is also the test boundary.
- **The viewer stays read-only (ADR 0002) and the model stays pure (ADR 0003).** The renderer only transforms a string the detail seam already read; it touches neither the watched root nor the `Board` model. The body is never carried in the model — `readDetail` reads it lazily when the modal opens — so this dependency adds no state and no scan-path cost.
- **Rejected: hand-rolled formatting.** Superseded for the reason the PRD gives — it re-solves a solved problem and drifts from real markdown. A real renderer is worth one contained dependency.
- **Rejected: the `ink-markdown` package as the import.** Not a preference call — it physically cannot load under `ink@7` + ESM (`ERR_REQUIRE_ASYNC_MODULE`). Recorded here so a future reader does not "restore the missing dependency" without first checking whether an ESM-compatible `ink-markdown` exists; until one does, depending on its engine directly is the faithful implementation of this decision.
