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

/** The resolved configuration: one board, one root, the review-loop knobs. */
export interface Config {
  /** Absolute path to the directory Overseer scans. */
  readonly root: string;
  /**
   * The AI-review loop's tunable knobs (pass cap + effort). Always present:
   * absent `[review]` config resolves to {@link DEFAULT_REVIEW_CONFIG} (cap 3,
   * medium), so existing boards behave exactly as before.
   */
  readonly review: ReviewConfig;
}

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

  return { root, review: parseReview(parsed.review, configPath) };
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

/** Expand a leading `~` (or `~/`) to the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
