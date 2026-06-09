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

### Configurable AI-review turns and effort

The AI review loop ships with a hardcoded cap of **3** `/code-review` passes at
**medium** effort (see `CONTEXT.md` → Review outcome). Once there are real runs to
calibrate against, promote both to `config.toml` knobs — a per-board (or eventually
per-PRD) iteration cap and effort level — rather than baking the v1 defaults in
forever.
