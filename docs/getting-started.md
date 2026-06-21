# Getting started

This is the one narrative to read first. It takes you from a fresh checkout to a
**self-driving board**: you author a PRD, open Overseer, press one key, and watch
agents pick up the work and carry it through review. Each step builds on the last —
follow it top to bottom.

By the end you will have done the whole loop once, and the [keybindings](../README.md#keybindings)
and [troubleshooting](../README.md#troubleshooting) tables in the README will read
as reminders rather than mysteries.

## Before you start

Overseer is a viewer and an orchestrator — the work itself is done by the CLIs it
shells out to. Have these ready (see [Requirements](../README.md#requirements) for
the why):

- **Node.js ≥ 22**.
- **The `claude` CLI**, on your `PATH` and authenticated — Overseer dispatches,
  tracks, and stops agents through it. Run `claude --version` once to confirm it's
  found, and run it interactively once to sign in.
- **`git`** — agents do each Issue in its own worktree off a per-PRD feature branch.
- **`gh` (GitHub CLI)**, authenticated *only if* you want the PR features later
  (`gh auth login`). The board and the whole author → dispatch → review loop work
  without it.

If `claude` is missing or unauthenticated, dispatch (`d`) won't start any agents —
but it won't fail silently: the status line tells you the candidates failed to
start and the cards get a red `⊘ suppressed` marker. That's the single most common
first-run snag, and the board makes it visible.

## 1. Install and initialize

From a fresh checkout:

```sh
npm install
npm run build
node dist/cli.js init   # or `npm start init` to run from source
```

`init` is the one-step onboarding ([Setup](../README.md#setup)). It does two things:

1. **Installs Overseer's bundled authoring skills** into your global Claude skills
   directory, so they're available as `/overseer-*` commands in any `claude`
   session.
2. **Bootstraps a config** if you don't already have one: it writes
   `~/.config/overseer/config.toml` pointing at a default board **root** of
   `~/overseer-board`, and creates that directory. It never overwrites an existing
   config.

The **root** is the directory Overseer watches. It is *not* a code repo — it's the
home of your PRD and Issue markdown. The code your PRDs are *about* lives in
separate repos. To point the root somewhere else, edit `root` in the config; a
leading `~` expands to your home directory, and the path must exist.

Optionally `npm link` (or `npm install -g .`) to get the `overseer` command on your
`PATH` — the rest of this guide uses `overseer` for brevity.

## 2. Author your first PRD with the skills

You *could* hand-write a `prd.md`, but the bundled skills are the intended path.
They're a chain — each hands off to the next — that you run inside a `claude`
session:

1. **`/overseer-grill-with-docs`** — start here when you have an idea or a rough
   plan. The skill interviews you relentlessly, one question at a time, walking down
   each branch of the design until you and it share an understanding of what you're
   building. When you reach a natural stopping point it points you onward.
2. **`/overseer-to-prd`** — synthesizes that conversation into a `prd.md`, written
   into a **new folder under your root**. That folder, by virtue of containing a
   `prd.md`, *is* a PRD. The skill then points you at the next station.
3. **`/overseer-to-issues`** — breaks the PRD into independently-grabbable **Issue**
   files (vertical, tracer-bullet slices) written alongside the `prd.md` in the same
   folder. Each Issue is born already routed — `ready-for-agent` for work an agent
   can take autonomously, `ready-for-human` for work that needs you — so the board
   knows who picks it up.

When `/overseer-to-issues` finishes, your root looks like this (see
[Layout it expects](../README.md#layout-it-expects)):

```
~/overseer-board/
└── my-first-feature/
    ├── prd.md
    ├── 001-first-slice.md      # status: ready-for-agent
    └── 002-second-slice.md     # status: ready-for-agent
```

That's the whole authoring half. The work is now **files on disk** — which means
it's a live board. Don't dispatch agents from the authoring conversation; open the
board, where dispatch is tracked.

## 3. Open the board

```sh
overseer            # or: npm start
```

Overseer scans your root and renders a **full-screen** kanban board on the
terminal's alternate screen (like vim or htop — your shell is restored on quit).
You'll see your PRD as a card. The board has two zoom levels:

- The **board** view: a 3-column board of PRDs (backlog / in-progress / done).
- The **Issue** view: press `Enter` on a PRD to zoom in and see its Issues across
  the 7 status columns; `Esc` backs out.

Move the selection with the arrow keys or `h` `j` `k` `l`. Press `?` any time for
the full keybinding reference.

> **Board empty?** A folder counts as a PRD only if it directly contains a
> `prd.md`. If you see nothing, re-check step 2 and the
> [troubleshooting table](../README.md#troubleshooting).

## 4. Press `d` — dispatch the work

Select your PRD on the board and press **`d`**. This *ignites* the PRD: Overseer
fans out one background `claude` agent per ready Issue. Each agent:

- works in its **own git worktree** off the PRD's feature branch, so agents don't
  collide,
- implements its Issue, then writes its result back as a **status change**.

You'll see the Issues move across the board live as the agents work — the watcher
re-scans on every filesystem change, so the board reflects whatever the files now
say.

> If pressing `d` reports that the candidates **failed to start** (and the cards
> show a red `⊘ suppressed` marker), `claude` is almost certainly missing from your
> `PATH` or unauthenticated. See
> [troubleshooting](../README.md#troubleshooting).

## 5. Watch the Reactor drive it

Here's the part that makes Overseer self-driving. After you ignite a PRD once, the
**Reactor** takes over: as work becomes eligible it auto-spawns the next agents
with no further keypress. Finishing one Issue unblocks and dispatches its siblings
automatically.

And finished work doesn't just sit there: a **reviewer** agent picks up each
completed Issue and loops `/code-review` (up to a configurable cap — see
[Tuning the AI review loop](../README.md#tuning-the-ai-review-loop-optional)),
fixing what it finds. It either **merges** the work or escalates it to a
**human-review** queue when it can't converge, hits a merge conflict, or the
implementor flagged a deviation.

While that runs you stay in control:

- Each card shows **liveness** — live, unknown, or orphaned.
- Press `R` to re-dispatch an Issue whose agent died mid-flight.
- Press `K` to stop a running agent.
- Press `a` to toggle **auto-run** — the Reactor's brake — if you want to step
  through the work manually instead.

That's the full loop: you authored a PRD, pressed one key, and the board carried it
from `ready-for-agent` through implementation and review on its own.

## 6. (Optional) Close the loop to GitHub

Once a PRD reaches **done**, you can open a pull request for it without leaving the
board:

- Press **`P`** to open a GitHub PR for the done PRD.
- A marker on the card shows whether its PR is open or merged.
- Press **`g`** to open that PR in your browser.

These are the only features that need `gh`. If `P` or `g` seem to do nothing, run
`gh auth login` (see [troubleshooting](../README.md#troubleshooting)).

## Where to go next

- The [keybinding table](../README.md#keybindings) is the full map of what each key
  does and where it applies.
- [`CONTEXT.md`](../CONTEXT.md) defines the domain language; [`docs/adr/`](./adr/)
  records the architectural decisions behind the behavior you just watched.
- Hit a snag? The [troubleshooting table](../README.md#troubleshooting) maps each
  first-run symptom to its fix.
