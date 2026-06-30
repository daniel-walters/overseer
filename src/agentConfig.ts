/**
 * The per-edge agent runtime knobs: which model a spawned `claude --bg` agent
 * runs, and at what reasoning effort. Promoted out of the spawn edge so a board
 * can tune the implementor and reviewer agents independently — a capable model
 * at high effort for the implementor (a correct first implementation collapses
 * the review loop), a faster model at lower effort for the per-pass reviewer —
 * without editing source.
 *
 * Distinct from {@link import("./review/reviewConfig.js").ReviewConfig.effort},
 * which is the `/code-review` skill's *thoroughness* embedded in the reviewer
 * prompt. This `effort` is the agent *session's* reasoning effort, passed to the
 * CLI as `--effort`. The two are orthogonal: one governs how hard the review
 * skill looks, the other how hard the agent thinks across the whole session.
 */

/**
 * The session reasoning-effort levels the `claude` CLI accepts for `--effort`.
 * Mirrors the CLI's own vocabulary; the config validator rejects anything else,
 * so an unsupported value fails at config load rather than at spawn time.
 */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A session reasoning-effort level — one of {@link AGENT_EFFORTS}. */
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/**
 * One spawned agent's runtime: the model and the session effort. Either may be
 * `null`, meaning "do not pass the flag — inherit the launcher's default". A
 * fully-`null` config (the default) makes the spawn byte-for-byte what it was
 * before this knob existed, so an unconfigured board is unchanged.
 */
export interface AgentConfig {
  /**
   * The `--model` value: an alias (`opus`, `sonnet`, `haiku`, `fable`) or a full
   * model id. `null` ⇒ omit `--model` and inherit the launcher's model.
   */
  readonly model: string | null;
  /**
   * The `--effort` value, one of {@link AGENT_EFFORTS}. `null` ⇒ omit `--effort`
   * and inherit the launcher's effort.
   */
  readonly effort: AgentEffort | null;
}

/**
 * The inherit-everything default: pass neither `--model` nor `--effort`, so a
 * board that configures no `[implementor]` / `[reviewer]` table spawns agents
 * exactly as it did before these knobs existed.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = { model: null, effort: null };

/**
 * The auditor edge's default runtime: model `opus`, effort inherited. The one
 * intentional asymmetry from {@link DEFAULT_AGENT_CONFIG}'s inherit-everything
 * (ADR 0026) — a fresh-eyes plan-conformance gate is only worth having if it is
 * strong, so the auditor reaches for the most capable model by default even on a
 * board that configures no `[auditor]` table. `effort` still inherits (`null`),
 * matching the other two edges, so only the model diverges.
 */
export const DEFAULT_AUDITOR_CONFIG: AgentConfig = { model: "opus", effort: null };

/**
 * Build the `claude` CLI flag pair for an agent runtime: `--model <m>` and/or
 * `--effort <e>`, each emitted only when its value is set. A `null`/absent value
 * (or absent config) yields no flag for that knob, so the spawn inherits the
 * launcher default. Returned as a flat arg array ready to splice into the
 * `claude --bg …` argv.
 */
export function agentFlags(agent?: AgentConfig): string[] {
  const flags: string[] = [];
  if (agent?.model) flags.push("--model", agent.model);
  if (agent?.effort) flags.push("--effort", agent.effort);
  return flags;
}
