import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { errorMessage } from "./errorMessage.js";

/** The resolved configuration: one board, one root. */
export interface Config {
  /** Absolute path to the directory Overseer scans. */
  readonly root: string;
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

  return { root };
}

/** Expand a leading `~` (or `~/`) to the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
