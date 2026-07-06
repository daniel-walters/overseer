import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expandHome } from "../config.js";

/**
 * Render the contents of a freshly-bootstrapped `config.toml` for the given
 * `root`. Beyond the required `root`, this ships the recommended Agent-runtime
 * split (`[implementor]` opus/high, `[reviewer]` sonnet/medium, `[auditor]`
 * sonnet/medium) and the review loop (`[review]` cap 3, medium) so a first-time
 * board is tuned out of the box instead of leaving every knob at the
 * inherit-the-launcher default — the user no longer has to hand-add these
 * tables after `overseer init`.
 *
 * Kept in lock-step with `config.example.toml`, which documents the same tables
 * as the copy-this reference. Note this only affects the *written file*: the
 * code-level default for an absent table remains "inherit" (see ADR 0020) —
 * except `[auditor]`, whose absent default is a pinned sonnet/medium (ADR 0026),
 * so a board that deletes a table still behaves exactly as before.
 */
export function defaultConfigContents(root: string): string {
  return `# Overseer config. \`root\` is the directory that holds your PRD folders.
# A leading ~ is expanded. Edit it to point the board elsewhere.
root = "${root}"

# --- Agent runtime ------------------------------------------------------------
# Which model each spawned \`claude --bg\` agent runs, and at what session effort.
# Both \`model\` and \`effort\` are optional per table; omit either to inherit the
# launcher's default. \`model\` takes an alias (opus, sonnet, haiku, fable) or a
# full model id; \`effort\` is one of low, medium, high, xhigh, max.
#
# Recommended split: the implementor does long-horizon, test-first coding — a
# correct first implementation collapses the review loop — so give it the most
# capable model at high effort. The reviewer runs once per pass (and may run up
# to \`review.cap\` times), so a faster model at medium effort keeps each pass
# quick; bump it toward opus/high if you find reviews missing real bugs.

[implementor]
model = "opus"
effort = "high"

[reviewer]
model = "sonnet"
effort = "medium"

# The fresh-eyes plan-conformance auditor. Unlike the tables above, [auditor] is
# NOT inherit-by-default: even if this table (or either field) is omitted it
# defaults to sonnet/medium, so the gate is always pinned to a known runtime.
# It's written out anyway to surface the knob — edit or delete it freely.

[auditor]
model = "sonnet"
effort = "medium"

# --- Review loop --------------------------------------------------------------
# \`cap\` is the number of \`/code-review\` passes before an Issue escalates to
# human-review (default 3). \`effort\` is the \`/code-review\` skill's THOROUGHNESS
# (low | medium | high, default medium) — distinct from \`reviewer.effort\` above,
# which is how hard the reviewer *agent* reasons across its whole session.

[review]
cap = 3
effort = "medium"
`;
}

/** Options for {@link ensureConfig}; mirrors {@link import("../config.js").LoadConfigOptions}. */
export interface EnsureConfigOptions {
  /** Path to the TOML config file. Defaults to `~/.config/overseer/config.toml`. */
  configPath?: string;
  /** Home directory used to expand a leading `~` in the default root. */
  home?: string;
  /** Root path to write into a freshly-bootstrapped config. Defaults to `~/overseer-board`. */
  defaultRoot?: string;
}

/** Outcome of {@link ensureConfig}. */
export interface EnsureConfigResult {
  /** `true` if a config was written; `false` if one already existed and was left untouched. */
  readonly created: boolean;
  /** The config path that was checked. */
  readonly configPath: string;
}

/**
 * Ensure a working Overseer config exists, bootstrapping one if absent.
 *
 * If the config file is missing, this expands and `mkdir -p`s the default root
 * (so the written config passes {@link import("../config.js").loadConfig}'s
 * "root must exist" check on the next launch), then writes a TOML config whose
 * `root` is the default root along with the recommended Agent-runtime and review
 * tables (see {@link defaultConfigContents}), and reports that it created the
 * config.
 *
 * If the config file already exists, nothing is touched — the file is left
 * byte-for-byte unchanged and no root directory is created — and it reports the
 * config already existed.
 */
export function ensureConfig(
  options: EnsureConfigOptions = {},
): EnsureConfigResult {
  const home = options.home ?? homedir();
  const configPath =
    options.configPath ?? join(home, ".config", "overseer", "config.toml");
  const defaultRoot = options.defaultRoot ?? "~/overseer-board";

  if (existsSync(configPath)) {
    return { created: false, configPath };
  }

  // The root must exist before the config is validated: loadConfig hard-fails
  // if `root` is not an existing directory.
  mkdirSync(expandHome(defaultRoot, home), { recursive: true });

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, defaultConfigContents(defaultRoot));

  return { created: true, configPath };
}
