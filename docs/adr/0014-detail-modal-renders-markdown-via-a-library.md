# The detail modal renders markdown via a library, accepting a render dependency

## Status

accepted

## Context

Overseer reads every PRD/Issue markdown file but **never shows the body** — cards
render only title, badges, and markers (CONTEXT.md → View). To read what an Issue
actually says (its `## What to build`, acceptance criteria, a PRD's problem
statement) the user must open the file outside the app. For a tool whose whole job
is surfacing PRD/Issue work as a live board, not being able to read the work from
inside it is a real gap. The fix is a **detail modal** — a `v` keybind opens a
full-screen modal showing the selected card's frontmatter-stripped body (the PRD's
`prd.md` at board level, the Issue file when zoomed), reusing the existing
`ActiveModal` machinery.

The open question is **how the body is rendered**. Markdown is designed to be
readable as plain text, so three shapes were on the table:

1. **Raw frontmatter-stripped text** in a `<Text>` — zero parsing, no new
   dependency. Legible, but headings, lists, and `- [ ]` checkboxes render as their
   literal markdown source.
2. **Hand-rolled light formatting** — bespoke parsing in the render layer to bold
   `#` headings, indent bullets, draw checkboxes. No dependency, but every markdown
   edge case becomes a render bug to maintain.
3. **A markdown-to-terminal library** — render the body through an existing,
   tested markdown renderer.

Overseer's `package.json` is deliberately lean (a handful of runtime deps:
`chokidar`, `gray-matter`, `ink`, `meow`, `react`, `smol-toml`), and every existing
dependency earns its place as core infrastructure. None is cosmetic. A render
library would be the **first dependency adopted for presentation fidelity** rather
than core function — a real departure from that posture.

## Decision

The detail modal renders the frontmatter-stripped markdown body through
**`ink-markdown`** (which wraps `marked-terminal`), accepting the dependency it and
its transitive chain (`marked`, `marked-terminal`) add. The modal renders the body
to terminal lines via the library, then windows those lines for scrolling (`j`/`k`/
arrows), so headings, lists, and checkboxes display as formatted terminal output
rather than raw markdown source.

We use the `ink-markdown` wrapper rather than wiring `marked-terminal` by hand: it
is the established Ink-native component for exactly this, so the modal stays a thin
consumer and we do not own a bespoke markdown-render seam. The body is **read
lazily on modal open** (a `readDetail(cardId, level)` seam shaped like the existing
preview seams — `readOpenPr`, `readKill`), never carried in the `Board` model, so
the scanner stays the pure frontmatter-deriving core (ADR 0003) and no re-scan holds
every body in memory.

## Consequences

- **Fidelity over leanness, recorded deliberately.** Overseer gains its first
  presentation-only dependency. This is a conscious reversal of the "raw text is
  already legible" instinct, made because the PRD's whole purpose is *legibility* and
  formatted headings/lists/checkboxes materially aid reading a long PRD body. Noted
  here so a future reader does not "simplify" the dependency away without re-opening
  this trade-off — and so the bar for the *next* cosmetic dependency is visibly
  raised, not silently lowered.
- **The choice is contained behind one seam.** Rendering happens in the detail
  modal only; nothing else in the app touches `ink-markdown`. Swapping the renderer
  later (to `marked-terminal` directly, to another library, or back to raw text) is a
  change to one component, so the dependency is reversible at low cost despite being
  a real commitment now.
- **The read-only viewer (ADR 0002) holds.** The modal only reads — the
  `readDetail` seam reads the selected file off disk on open, strips frontmatter, and
  renders it; it writes nothing, to the watched root or anywhere. The body view adds
  no writer.
- **Scanner and model stay untouched (ADR 0003).** Because the body is read
  on-open rather than carried in the `Board`, `scanBoard` and the model are unchanged
  — the render dependency does not leak into the deep core, only into the UI surface
  that consumes it.
- **Degradation is quiet.** An empty body shows a placeholder, a file that vanished
  between scan and keypress makes the keybind a no-op (mirroring the preview seams'
  `undefined` contract), and a malformed-frontmatter file renders its raw content —
  so the library never faces input that breaks the modal.
