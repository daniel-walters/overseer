# Build Overseer as an Ink + TypeScript TUI

We considered Go + Bubble Tea (and earlier Rust/Ratatui, Python/Textual) but chose **Ink + TypeScript**. The decisive factor is roadmap-driven: a planned future capability is **spawning and managing Claude agent instances from the board**, and the Claude Agent SDK is TypeScript-first — agents become in-process, typed, streamable objects rather than subprocesses whose CLI output we scrape. Ink's declarative flexbox layout is also a strong fit for a multi-column kanban, and TypeScript is the maintainer's primary language.

## Considered Options

- **Go + Bubble Tea** — best architectural fit for "rebuild board on re-scan, keep UI state separate" and ships a single static binary; rejected because spawning agents would mean shelling out and parsing CLI output instead of using the typed SDK, and the manual Lip Gloss layout is more work for a column-heavy UI. (Glamour markdown rendering was a minor point in its favor.)
- **Rust + Ratatui** — fast, single binary; more ceremony for the same result, and same SDK disadvantage as Go.
- **Python + Textual** — richest widgets and Python Agent SDK exists, but ships a runtime rather than being the maintainer's daily language.

## Consequences

- Overseer ships on Node (not a single binary); distribution needs `node` or a bundler (pkg/bun).
- Stack: Ink + React for the UI, `chokidar` for the debounced file watcher, `gray-matter` for frontmatter parsing, a TOML parser for config, and the `@anthropic-ai/claude-agent-sdk` for the future agent-spawning capability.
