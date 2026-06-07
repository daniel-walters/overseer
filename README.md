# Overseer

A terminal (TUI) app that reads PRDs and Issues authored as markdown on disk and
renders them as a kanban board. See [`CONTEXT.md`](./CONTEXT.md) for the domain
language and [`docs/adr/`](./docs/adr/) for architectural decisions.

> **Status:** tracer-bullet slice. Renders a **static** board of PRDs (config →
> scan → render). Live file watching, PRD-zoom, and Issue cards land in later
> slices.

## Requirements

- Node.js ≥ 22

## Setup

```sh
npm install
```

Create a config file at `~/.config/overseer/config.toml` pointing at the
directory that holds your PRD folders:

```toml
root = "~/work/prds"
```

A leading `~` is expanded to your home directory. The `root` must exist.

## Layout it expects

Folder-per-PRD under the root. A directory containing a `prd.md` **is** a PRD;
a directory without one is ignored.

```
<root>/
├── auth-system/
│   └── prd.md        # title + status frontmatter
└── billing/
    └── prd.md
```

A PRD's card title comes from its `title` frontmatter (falling back to the
directory name); its column comes from its `status` frontmatter. Canonical
statuses: `backlog`, `ready-for-human`, `ready-for-agent`, `in-progress`,
`in-review`, `done`. The two `ready-for-*` values share the **Ready** column and
show a 🧑/🤖 badge. A missing or unrecognized status lands the card in the
leftmost **Unsorted** column rather than dropping it.

Overseer is a **read-only viewer** — it never writes your PRD or Issue files.

## Run

```sh
npm start          # run from source via tsx
npm run build      # compile to dist/
node dist/cli.js   # run the built CLI
```

## Develop

```sh
npm test           # run the test suite once (vitest)
npm run test:watch # watch mode
npm run typecheck  # type-check the whole tree, tests included
```

### Architecture

The codebase is split into deep modules with simple, testable interfaces:

- **`config`** — `loadConfig()` reads and validates the root from the TOML config.
- **`scanner`** — `scanBoard(root)` is a pure path → `Board` function (the deep
  core): directory walking, `prd.md` detection, frontmatter parsing, status
  normalization, and the Unsorted fallback. No watching, no rendering, no writes.
- **`ui`** — Ink/React components that render a `Board` as columns of cards.
- **`cli`** — thin wiring: `loadConfig` → `scanBoard` → Ink render.
