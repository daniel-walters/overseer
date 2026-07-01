import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { errorMessage } from "./errorMessage.js";
import {
  DEFAULT_REVIEW_CONFIG,
  REVIEW_EFFORTS,
  type ReviewConfig,
  type ReviewEffort,
} from "./review/reviewConfig.js";
import {
  AGENT_EFFORTS,
  DEFAULT_AGENT_CONFIG,
  type AgentConfig,
  type AgentEffort,
} from "./agentConfig.js";
import {
  DEFAULT_EPIC_STATUS_NAMES,
  type EpicStatusNames,
} from "./jira/statusMapping.js";

/** The resolved configuration: one board, one root, the review-loop + agent knobs. */
export interface Config {
  /** Absolute path to the directory Overseer scans. */
  readonly root: string;
  /**
   * The AI-review loop's tunable knobs (pass cap + `/code-review` effort). Always
   * present: absent `[review]` config resolves to {@link DEFAULT_REVIEW_CONFIG}
   * (cap 3, medium), so existing boards behave exactly as before. Note `review.effort`
   * is the review *skill's* thoroughness, distinct from `reviewer.effort` below
   * (the reviewer agent's session reasoning effort).
   */
  readonly review: ReviewConfig;
  /**
   * The implementor agent's runtime (model + effort), from `[implementor]`. Always
   * present: absent config resolves to {@link DEFAULT_AGENT_CONFIG} (inherit the
   * launcher's model/effort), so an unconfigured board spawns implementors as before.
   */
  readonly implementor: AgentConfig;
  /**
   * The reviewer agent's runtime (model + effort), from `[reviewer]`. Always
   * present: absent config resolves to {@link DEFAULT_AGENT_CONFIG} (inherit), so an
   * unconfigured board spawns reviewers as before. The session-level `effort` here is
   * distinct from `review.effort`, which tunes the `/code-review` skill itself.
   */
  readonly reviewer: AgentConfig;
  /**
   * The JIRA mirror's connection + status knobs, from `[jira]` (ADR 0028). Always
   * present: absent `[jira]` config resolves to {@link DEFAULT_JIRA_CONFIG} (no
   * default board, conventional status names), so the mirror stays *off by
   * default* — it activates per-PRD via the authored `jira` block, never by the
   * config's presence (ADR 0029). acli owns auth, so this table stores no
   * credential — only the default board and any status-name overrides.
   */
  readonly jira: JiraConfig;
}

/**
 * The resolved `[jira]` config. `defaultBoard` is the board a `jira`-opted PRD
 * mirrors to when its block names none (the common case); it is optional because
 * a PRD may name its own `board`, and a board is only *needed* once a PRD opts in.
 * `statusNames` is always whole — the {@link EpicStatusNames} defaults filled in
 * for any name the `[jira.status]` table did not override.
 */
export interface JiraConfig {
  readonly defaultBoard?: string;
  readonly statusNames: EpicStatusNames;
}

/** The mirror's resolved defaults: no board configured, conventional status names. */
export const DEFAULT_JIRA_CONFIG: JiraConfig = {
  statusNames: DEFAULT_EPIC_STATUS_NAMES,
};

/** Options for {@link loadConfig}; the defaults point at the real environment. */
export interface LoadConfigOptions {
  /** Path to the TOML config file. Defaults to `~/.config/overseer/config.toml`. */
  configPath?: string;
  /** Home directory used to expand a leading `~` and locate the default config. */
  home?: string;
}

/** Raised for any user-fixable config problem; message is safe to show as-is. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Read and validate Overseer's config.
 *
 * Reads `root` from the TOML config file, expands a leading `~` to the home
 * directory, and verifies the root exists and is a directory. Every failure
 * surfaces as a {@link ConfigError} with a message the user can act on.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const home = options.home ?? homedir();
  const configPath =
    options.configPath ?? join(home, ".config", "overseer", "config.toml");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new ConfigError(
      `No config file at ${configPath}. Create it with: root = "~/your/prds"`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Config at ${configPath} is not valid TOML: ${errorMessage(err)}`,
    );
  }

  const rawRoot = parsed.root;
  if (typeof rawRoot !== "string" || rawRoot.trim() === "") {
    throw new ConfigError(
      `Config at ${configPath} is missing a "root" path. Add: root = "~/your/prds"`,
    );
  }

  const root = expandHome(rawRoot.trim(), home);

  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new ConfigError(`Root directory does not exist: ${root}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfigError(`Root path is not a directory: ${root}`);
  }

  return {
    root,
    review: parseReview(parsed.review, configPath),
    implementor: parseAgent(parsed.implementor, "implementor", configPath),
    reviewer: parseAgent(parsed.reviewer, "reviewer", configPath),
    jira: parseJira(parsed.jira, configPath),
  };
}

/**
 * Parse the optional `[jira]` table into a complete {@link JiraConfig}, filling
 * absent knobs from {@link DEFAULT_JIRA_CONFIG} so the result is always whole. An
 * absent table is the mirror-off default (no board, conventional status names); a
 * present-but-malformed value is a user-fixable {@link ConfigError}, matching the
 * rest of the module. acli owns auth, so nothing credential-like is read here.
 */
function parseJira(raw: unknown, configPath: string): JiraConfig {
  if (raw === undefined) return DEFAULT_JIRA_CONFIG;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `Config at ${configPath} has a "[jira]" that is not a table.`,
    );
  }
  const table = raw as Record<string, unknown>;
  return {
    defaultBoard: parseDefaultBoard(table.default_board, configPath),
    statusNames: parseStatusNames(table.status, configPath),
  };
}

/**
 * A `default_board` is a board id. Absent ⇒ `undefined` (a PRD must then name its
 * own `board`). A number is coerced to its string form (board ids are numeric, so
 * `default_board = 42` and `default_board = "42"` mean the same board); any other
 * type is a user-fixable {@link ConfigError}.
 */
function parseDefaultBoard(
  raw: unknown,
  configPath: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "jira.default_board": expected a board id string, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw.trim();
}

/**
 * Parse the optional `[jira.status]` override table into a complete
 * {@link EpicStatusNames}, filling each absent name from
 * {@link DEFAULT_EPIC_STATUS_NAMES}. The lane-named keys (`backlog`,
 * `in-progress`, `done`) map onto the camelCased status fields; a present name
 * must be a non-blank string or it is a user-fixable {@link ConfigError}.
 */
function parseStatusNames(raw: unknown, configPath: string): EpicStatusNames {
  if (raw === undefined) return DEFAULT_EPIC_STATUS_NAMES;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `Config at ${configPath} has a "[jira.status]" that is not a table.`,
    );
  }
  const table = raw as Record<string, unknown>;
  return {
    backlog: parseStatusName(
      table.backlog,
      "backlog",
      DEFAULT_EPIC_STATUS_NAMES.backlog,
      configPath,
    ),
    inProgress: parseStatusName(
      table["in-progress"],
      "in-progress",
      DEFAULT_EPIC_STATUS_NAMES.inProgress,
      configPath,
    ),
    done: parseStatusName(
      table.done,
      "done",
      DEFAULT_EPIC_STATUS_NAMES.done,
      configPath,
    ),
  };
}

/** A single status-name override: absent ⇒ the default; present ⇒ a non-blank string. */
function parseStatusName(
  raw: unknown,
  key: string,
  fallback: string,
  configPath: string,
): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "jira.status.${key}": expected a non-empty status name, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw.trim();
}

/**
 * Parse the optional `[review]` table into a complete {@link ReviewConfig},
 * filling each absent knob from {@link DEFAULT_REVIEW_CONFIG} so the result is
 * always whole. An absent table (or absent field within it) is the current
 * behaviour (cap 3, medium); a present-but-malformed value is a user-fixable
 * {@link ConfigError}, matching the rest of the module's error style.
 */
function parseReview(raw: unknown, configPath: string): ReviewConfig {
  if (raw === undefined) return DEFAULT_REVIEW_CONFIG;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `Config at ${configPath} has a "[review]" that is not a table.`,
    );
  }
  const table = raw as Record<string, unknown>;
  return {
    cap: parseCap(table.cap, configPath),
    effort: parseEffort(table.effort, configPath),
  };
}

/** A review cap must be a positive integer; absent falls back to the default. */
function parseCap(raw: unknown, configPath: string): number {
  if (raw === undefined) return DEFAULT_REVIEW_CONFIG.cap;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "review.cap": expected a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

/** A review effort must be one of {@link REVIEW_EFFORTS}; absent falls back to the default. */
function parseEffort(raw: unknown, configPath: string): ReviewEffort {
  if (raw === undefined) return DEFAULT_REVIEW_CONFIG.effort;
  if (
    typeof raw !== "string" ||
    !(REVIEW_EFFORTS as readonly string[]).includes(raw)
  ) {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "review.effort": expected one of ${REVIEW_EFFORTS.join(", ")}, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw as ReviewEffort;
}

/**
 * Parse an optional agent-runtime table (`[implementor]` or `[reviewer]`) into a
 * complete {@link AgentConfig}, filling each absent knob from
 * {@link DEFAULT_AGENT_CONFIG} (`null` ⇒ inherit, pass no flag). An absent table
 * (or absent field) is the pre-knob behaviour; a present-but-malformed value is a
 * user-fixable {@link ConfigError}, matching the rest of the module's style.
 * `table` names which table for error messages (`implementor` / `reviewer`).
 */
function parseAgent(
  raw: unknown,
  table: string,
  configPath: string,
): AgentConfig {
  if (raw === undefined) return DEFAULT_AGENT_CONFIG;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `Config at ${configPath} has a "[${table}]" that is not a table.`,
    );
  }
  const fields = raw as Record<string, unknown>;
  return {
    model: parseModel(fields.model, table, configPath),
    effort: parseAgentEffort(fields.effort, table, configPath),
  };
}

/** A model must be a non-empty string if present; absent ⇒ `null` (inherit). */
function parseModel(
  raw: unknown,
  table: string,
  configPath: string,
): string | null {
  if (raw === undefined) return DEFAULT_AGENT_CONFIG.model;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "${table}.model": expected a non-empty string (e.g. "opus", "sonnet"), got ${JSON.stringify(raw)}.`,
    );
  }
  return raw.trim();
}

/** An agent effort must be one of {@link AGENT_EFFORTS}; absent ⇒ `null` (inherit). */
function parseAgentEffort(
  raw: unknown,
  table: string,
  configPath: string,
): AgentEffort | null {
  if (raw === undefined) return DEFAULT_AGENT_CONFIG.effort;
  if (
    typeof raw !== "string" ||
    !(AGENT_EFFORTS as readonly string[]).includes(raw)
  ) {
    throw new ConfigError(
      `Config at ${configPath} has an invalid "${table}.effort": expected one of ${AGENT_EFFORTS.join(", ")}, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw as AgentEffort;
}

/** Expand a leading `~` (or `~/`) to the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
