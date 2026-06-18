# Per-edge agent model and effort are configurable

## Status

accepted

## Context

Every dispatched agent — implementor and reviewer alike — launches through one
spawn edge (`spawn.ts` → `createSpawnEdge`), which until now ran a fixed
`claude --bg --permission-mode auto -p <prompt>`. With no `--model`/`--effort`,
both edges inherit whatever the launching session defaults to.

That single default is the wrong shape for the pipeline, because the two edges
have opposite cost/quality profiles:

- The **implementor** does long-horizon, test-first coding from a cold start. A
  correct first implementation is what *collapses* the review loop — clean code
  converges in one pass instead of triggering up to `review.cap` reviewer spawns
  ([ADR 0018](./0018-reactor-owns-the-review-loop-not-the-agent.md)). This is the
  highest-leverage place to spend model capability.
- The **reviewer** runs once per pass and may run several times per Issue, so
  per-pass latency compounds. A faster model at lower effort keeps each pass
  cheap, with the cap + human-review escalation as the backstop.

A board operator should be able to set each independently — e.g. a capable model
at high effort for the implementor, a faster one at medium for the reviewer —
without editing source, exactly as `review.cap`/`review.effort` are already
tunable from `config.toml`.

The `claude` CLI exposes both knobs: `--model <alias|id>` and
`--effort <low|medium|high|xhigh|max>`.

### Effort is two different things — keep them separate

There is already a `review.effort` knob. It is the **`/code-review` skill's
thoroughness**, embedded as text in the reviewer prompt
(`reviewerPrompt.ts`). The knob this ADR adds is the **agent session's reasoning
effort** (`--effort`). They are orthogonal — one governs how hard the review
*skill* looks, the other how hard the *agent* thinks across its whole session —
and conflating them would lose that axis (and break, since the two vocabularies
differ). So they stay distinct config fields, documented as such.

## Decision

- Introduce `AgentConfig { model: string | null; effort: AgentEffort | null }`
  (`src/agentConfig.ts`), where `null` means "omit the flag, inherit the
  launcher default". `agentFlags()` renders it to the `--model`/`--effort` argv
  slice, emitting each flag only when its knob is set.
- The spawn seam gains an optional third argument:
  `spawn(repo, prompt, agent?)`. It is **per-call**, not bound at construction,
  so the *one* shared `createSpawnEdge` launches each edge at its own runtime —
  the implementor edge passes its config, the reviewer edge passes its own. An
  omitted/all-`null` config reproduces the pre-knob argv byte-for-byte, so an
  unconfigured board is unchanged.
- The runtime is threaded through the existing flip-then-spawn machinery
  (`SpawnWithFlip.agent` → `DispatchDeps`/`ReviewDeps` → `dispatcher`/`reviewer`
  → `ReactorDeps.implementor`/`.reviewer`). Every new deps field is **optional**,
  defaulting to inherit, so the Reactor's own wiring tests and the manual `d`/`r`
  edges need no change to keep their current behaviour. The CLI threads the same
  `[implementor]`/`[reviewer]` config into the manual edge and the auto edge, so
  a hand-driven launch and an automated one are identical (mirroring how
  `review` is shared today).
- Two new optional config tables, `[implementor]` and `[reviewer]`, each with
  `model` and `effort`, parsed in `config.ts` alongside `[review]`. Absent table
  or field → inherit. A present-but-malformed value is a `ConfigError`, matching
  the existing `[review]` parsing. `config.example.toml` ships the recommended
  split (implementor `opus`/`high`, reviewer `sonnet`/`medium`) and documents the
  `reviewer.effort` vs `review.effort` distinction.

The default stays **inherit, not the recommended split** — an unconfigured board
must behave exactly as before; the split is opt-in via the example config.

## Consequences

- **The pipeline's most expensive lever is now tunable per edge.** Capability
  goes where late mistakes are dear (the implementor); speed goes where it
  compounds (the per-pass reviewer).
- **One shared spawn edge still serves both.** The runtime is a per-call
  argument, so the "single `createSpawnEdge`" shape ([ADR 0008](./0008-liveness-via-claude-agents-handle-sidecar.md))
  survives — no per-edge spawn duplication.
- **Backward compatible.** No config, or a config with neither table, spawns
  exactly as before (no `--model`/`--effort`). All new deps fields are optional.
- **Two effort knobs coexist on the reviewer** — `reviewer.effort` (session
  reasoning) and `review.effort` (`/code-review` thoroughness). This is a real,
  documented distinction, not an oversight; folding them would erase a control
  axis and couple two different vocabularies.
- **The resolve edge is untouched.** It runs no agent ([ADR 0019](./0019-overseer-owns-the-review-merge-and-terminal-write.md)),
  so it has no model/effort and the "exactly two spawn edges" invariant is
  unaffected.
