# Overseer

A terminal (TUI) app that reads PRDs and Issues authored as markdown on disk and
renders them as a **live-updating kanban board** — then drives the work forward by
spawning Claude agents on your behalf. See [`CONTEXT.md`](./CONTEXT.md) for the
domain language and [`docs/adr/`](./docs/adr/) for architectural decisions.

Overseer is a **read-only viewer of your files** ([ADR 0002](./docs/adr/0002-agents-write-the-root-viewer-stays-readonly.md)):
it never edits your PRD/Issue markdown. Agents write the files back; the board
reflects whatever they now say, live. Operational state Overseer owns (which agents
it launched, which launches failed) lives outside the watched root as overlays on
the board, never inside your files.

> **New here? Start with the [getting-started walkthrough](./docs/getting-started.md)** —
> a single connected narrative from a fresh install through `init`, authoring your
> first PRD, opening the board, and pressing `d` to watch the agents drive it.

## What it does

- **Live kanban board.** Scans a root directory of PRD folders and renders them as
  cards, re-scanning on every filesystem change. Two zoom levels: a 3-column
  **board** of PRDs (backlog / in-progress / done), and a 7-column **Issue** view
  when you zoom into one PRD.
- **Dispatches agents.** Press `d` on a PRD to fan out one background `claude` agent
  per ready Issue. The agents do the work in their own git worktrees and write their
  results back as status changes you see land on the board.
- **Drives itself (the Reactor).** After you ignite a PRD once, the Reactor
  auto-spawns agents as work becomes eligible — completing one Issue unblocks and
  dispatches its siblings with no further keypress. Toggle this **auto-run** brake
  with `a`.
- **Reviews automatically.** A finished Issue is picked up by a reviewer agent that
  loops `/code-review` (up to a configurable cap), fixes what it finds, and either
  merges the work or escalates to a **human-review** queue when it can't converge,
  hit a merge conflict, or the implementor flagged a deviation.
- **Keeps you in the loop on escalations.** A `human-review` Issue's card shows
  *why* it landed there (deviation / conflict / non-convergence). Resolve it in
  place, then **approve** with `A` — the same merge-and-finish the clean path runs,
  human-triggered. Work you do yourself (`ready-for-human`) is closed with `m`.
- **Tracks the agents it launches.** Each card shows **liveness** (live / unknown /
  orphaned). Recover a dead in-flight Issue with `R`; stop a running agent with `K`;
  read a running agent's recent output with `o`.
- **Lets you read the work.** Press `v` (or `Enter` on an Issue) to view a PRD's or
  Issue's markdown body in a scrollable modal, without leaving the board.
- **Closes the loop to GitHub.** Open a PR for a `done` PRD with `P`; when the PRD's
  Issues were sliced for reviewability, this opens a **stack** of PRs instead of one.
  A marker shows whether a PRD's PR is open or merged; `g` opens it in the browser.
- **Tidies up.** Delete a finished PRD — its folder and all its Issue files — with
  `X`, once the card is just clutter.

## Requirements

- **Node.js ≥ 22**
- **The `claude` CLI**, on your `PATH` and authenticated. Overseer launches,
  tracks, and stops agents by shelling out to `claude --bg`, `claude agents`, and
  `claude stop`. Without it the board still renders, but `d`/`r` and the Reactor
  can't spawn anything.
- **`git`**, for the per-PRD feature branches and per-Issue worktrees agents build in.
- **`gh` (GitHub CLI)**, authenticated — only for the PR features (`P` / `g` and the
  linked-PR marker). Everything else works without it.

## Setup

Build the package and put the `overseer` command on your `PATH`, then run `init`:

```sh
pnpm install
pnpm build
pnpm link --global      # puts the `overseer` bin on your PATH
overseer init
```

The global link (`pnpm link --global`) is what lets you type `overseer`
anywhere instead of `node dist/cli.js`; it points the bin at the compiled
output, so `pnpm build` must come first. Prefer to run from source without
linking globally? Use `node dist/cli.js init` (or `pnpm start init`) instead —
everywhere below that says `overseer`, substitute one of those.

`init` is the one-step onboarding: it installs Overseer's bundled agent skills
into your global Claude skills directory and, if you have no config yet, writes one
pointing at a default board root of `~/overseer-board` (creating that directory).
The scaffolded config also ships the recommended **Agent runtime** split and
**review loop** defaults (see below), so a fresh board is tuned out of the box.
It never overwrites an existing config.

Then run `overseer doctor` to confirm your environment is ready — it checks Node,
the `claude` / `git` / `gh` CLIs, and your config, and prints a green/red checklist
of anything left to fix:

```sh
overseer doctor
```

It exits non-zero if a *required* prerequisite is missing (so you can gate on it),
and only *warns* about `gh`, which powers just the optional PR features.

For a guided first run from here — authoring a PRD with the skills, opening the
board, and igniting the work — follow the
[getting-started walkthrough](./docs/getting-started.md).

To point the board somewhere else, edit `~/.config/overseer/config.toml`:

```toml
root = "~/work/prds"
```

A leading `~` expands to your home directory. The `root` must exist.

### Tuning the AI review loop (optional)

A `[review]` table tunes the reviewer. Both fields are optional; omitting either
(or the whole table) keeps the defaults — a cap of **3** `/code-review` passes at
**medium** effort:

```toml
root = "~/work/prds"

[review]
cap = 3            # max /code-review passes before escalating to human-review
effort = "medium"  # /code-review effort per pass: low | medium | high
```

### Tuning the spawned agents (optional)

Separate `[implementor]` and `[reviewer]` tables tune the agents Overseer spawns —
the `--model` and session `--effort` each launches with. Both fields in both tables
are optional; an omitted field (or table) inherits the launcher's default, so an
unconfigured board spawns agents exactly as before. This lets you pair a capable
model at high effort for the implementor (a correct first cut collapses the review
loop) with a faster, cheaper model for the per-pass reviewer:

```toml
root = "~/work/prds"

[implementor]
model = "opus"     # alias (opus | sonnet | haiku | fable) or a full model id
effort = "high"    # session reasoning effort: low | medium | high | xhigh | max

[reviewer]
model = "sonnet"
effort = "medium"
```

Note `[review].effort` (the `/code-review` skill's thoroughness) is distinct from
`[reviewer].effort` (the reviewer agent session's reasoning effort) — they're
orthogonal knobs.

## Layout it expects

Folder-per-PRD under the root. A directory containing a `prd.md` **is** a PRD; a
directory without one is ignored. A PRD's Issues are the other markdown files
inside its folder.

```
<root>/
├── auth-system/
│   ├── prd.md                  # title frontmatter; status is derived from Issues
│   ├── 001-password-hashing.md # an Issue: title + status frontmatter
│   └── 002-oauth-provider.md
└── billing/
    └── prd.md
```

A card's title comes from its `title` frontmatter (a PRD falls back to the
directory name). A PRD has **no stored status** — its column is derived from its
Issues ([ADR 0003](./docs/adr/0003-prd-status-is-derived-not-stored.md)). An Issue
carries a `status` frontmatter field; canonical Issue statuses are `backlog`,
`ready-for-human`, `ready-for-agent`, `in-progress`, `ready-for-review`,
`in-review`, `human-review`, `done`. The two `ready-for-*` values share the
**ready** column with a 🧑/🤖 badge; a missing or unrecognized status folds into
**backlog** with a loud `⚠ bad status` marker rather than being dropped.

## Authoring work for the board

The bundled skills (installed by `overseer init`) are the authoring pipeline that
produces the PRDs and Issues Overseer reads:

- `overseer-grill-with-docs` — stress-test a plan and maintain the domain docs.
- `overseer-to-prd` — write the conversation up as a `prd.md` in the root.
- `overseer-to-issues` — break a PRD into independently-grabbable Issue files.
- `overseer-merge` — the human-invoked merge for a resolved `human-review` Issue.

Once the Issues are files in the root, open Overseer and ignite the work there
(`d`) — the board is where work is dispatched and observed.

## Keybindings

Press `?` in the app for the full reference. The current map:

| Key | Action | Where |
| --- | --- | --- |
| `h` `j` `k` `l` / arrows | Move selection | both |
| `Enter` | Zoom into a PRD's Issues (board) / view an Issue's body (issues) | both |
| `Esc` | Back out to the board | issues |
| `v` | View the selected card's body | both |
| `d` | Dispatch a wave of agents (resumes an in-progress PRD) | board |
| `P` | Open a GitHub PR (or a stack) for a done PRD | board |
| `g` | Go to the selected PRD's PR | board |
| `X` | Delete a done PRD (folder + all its Issues) | board |
| `r` | Review the selected Issue | issues |
| `R` | Re-dispatch an orphaned Issue | issues |
| `K` | Stop a live Issue's agent | issues |
| `o` | Read a live Issue's agent output | issues |
| `m` | Mark a ready-for-human Issue done | issues |
| `A` | Approve a human-review Issue (merge + done) | issues |
| `a` | Toggle auto-run (the Reactor brake) | both |
| `?` | Show the keybind reference | both |
| `q` | Quit (backs out first if zoomed) | both |

The board renders **full screen** on the terminal's alternate screen buffer (like
vim/htop) and restores your shell on quit. A column with more cards than fit
**scrolls vertically** to keep your selection in view. Horizontal scrolling across
columns is not yet implemented, so on a narrow terminal the 7-column Issue view can
clip at the screen edge (a logged follow-up in [`docs/ideas.md`](./docs/ideas.md)).

## Run

```sh
pnpm start         # run from source via tsx
pnpm build         # compile to dist/
node dist/cli.js   # run the built CLI
overseer           # run the linked bin
```

## Troubleshooting

First-timer failures are mostly missing or unauthenticated CLIs that Overseer
shells out to. **Run `overseer doctor` first** — it checks every prerequisite
below at once and tells you exactly what's missing. Then match any remaining
symptom to the fix:

| Symptom | What it means | Fix |
| --- | --- | --- |
| **A dispatched Issue never starts** | Overseer dispatches by shelling out to `claude --bg`; if `claude` isn't on your `PATH` or isn't authenticated the spawn fails. It is *not* silent — the status line reports the candidates "failed to start", the card gets a red `⊘ suppressed` marker, and the cause is appended to `~/.local/state/overseer/dispatch.log`. | Install the `claude` CLI, make sure it's on your `PATH`, and run it once to authenticate. Confirm with `claude --version`, then re-dispatch. |
| **`P` or `g` silently do nothing** | The PR features (open / go-to a PRD's GitHub PR) shell out to `gh`, which does nothing useful when GitHub CLI is unauthenticated. | Run `gh auth login`. Everything *except* the PR features works without `gh`. |
| **The board is empty** | A directory is a PRD only if it directly contains a `prd.md`; a root with no such folders has nothing to render. | Put a folder under your configured `root` that holds a `prd.md` (the `overseer-to-prd` skill writes one for you). Check the layout against [Layout it expects](#layout-it-expects). |
| **A config error on launch** | The configured `root` directory does not exist. Overseer validates the root at startup and refuses to render against a missing path. | Create the directory, or fix the `root` path in `~/.config/overseer/config.toml`. A leading `~` is expanded; the path must already exist. |

Still stuck on a fresh setup? Walk the
[getting-started guide](./docs/getting-started.md) end to end — it threads through
each of these prerequisites in order.

## Develop

```sh
pnpm test          # run the test suite once (vitest)
pnpm test:watch    # watch mode
pnpm typecheck     # type-check the whole tree, tests included
```

### Architecture

The codebase is split into deep modules with simple, testable interfaces:

- **`config`** — `loadConfig()` reads and validates the root (and `[review]`) from
  the TOML config.
- **`scanner`** — `scanBoard(root)` is a pure path → `Board` function (the deep
  core): directory walking, `prd.md` detection, frontmatter parsing, status
  normalization, PRD-status derivation, and the overlay seams (liveness /
  suppressed / linked-PR). No watching, no rendering, no writes.
- **`watcher`** — `chokidar` file watching, debounced into full re-scans.
- **`dispatch`** — the spawn edge: validate, ensure the PRD feature branch, flip
  status, launch `claude --bg`, and the operational overlays (liveness handle
  sidecar, kill, orphan rollback, open/linked PR).
- **`reactor`** — the in-process automation that reconciles both spawn frontiers
  after each re-scan and auto-spawns eligible work (auto-run).
- **`review`** — the reviewer agent and its `/code-review` loop, eligibility, and
  config.
- **`init`** — `overseer init`: bundled-skill install + config bootstrap.
- **`ui`** — Ink/React components that render a `Board`, plus the keybind registry
  and navigation reducer.
- **`cli`** — thin wiring: parse argv → `init` or `loadConfig` → `scanBoard` →
  live Ink render.
