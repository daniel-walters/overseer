# Ideas & future considerations

A running backlog of feature ideas and considerations for Overseer that aren't yet
committed work. Not the issue tracker — this is the holding pen before an idea is
shaped into a PRD or issues. See `CONTEXT.md` for domain language.

## Ideas

### Pause / resume development of a PRD

A way to pause and later resume development of a PRD. While paused, the dispatcher
should not spawn (or keep spawning) agents for that PRD's issues; resuming picks
development back up. Open questions: where does the pause state live (PRD frontmatter
vs. external state, given Overseer is a read-only viewer of the files), how it surfaces
on the board, and how in-flight agents are handled at the moment of pausing.

### Toggle the reactor on/off

The reactor (auto-spawn reviewers for `ready-for-review` Issues, and re-dispatch
implementors for Issues whose blockers just went `done`) ships **global and always-on**
in v1 — once a human kicks a PRD off with `d`, the reactor drives it the rest of the
way. A future control would let the user toggle the reactor off (a keybind or board
state) so they can watch the board live without auto-spawning — e.g. to pause a runaway
wave, or to step through dispatch manually with `d`/`r`. Relates to the per-PRD
pause/resume idea above (a global switch vs. per-PRD pause). Open question: off-by-default
vs. on-by-default once toggling exists.

### Surface reactor state on the board

The reactor is **visually invisible** in v1 — its only diagnostic surface is the
durable failure log. Two states that look identical to a healthy board but aren't:
(1) a spawn-failed Issue that rolled back to its eligible status and is now
**suppressed** by the session failed-set (looks like a normal `ready-*` card, but the
reactor is deliberately ignoring it); (2) idle vs. actively-working vs. at-rest. A
future UI pass would surface these — e.g. a card marker for spawn-failed/suppressed
Issues (mirroring the `human_review_reason` marker), and/or a board status line. For
now everything goes to the log; we surface in the UI later.

### Configurable AI-review turns and effort

The AI review loop ships with a hardcoded cap of **3** `/code-review` passes at
**medium** effort (see `CONTEXT.md` → Review outcome). Once there are real runs to
calibrate against, promote both to `config.toml` knobs — a per-board (or eventually
per-PRD) iteration cap and effort level — rather than baking the v1 defaults in
forever.
