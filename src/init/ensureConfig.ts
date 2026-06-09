import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expandHome } from "../config.js";

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
 * `root` is the default root, and reports that it created the config.
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
  writeFileSync(configPath, `root = "${defaultRoot}"\n`);

  return { created: true, configPath };
}
