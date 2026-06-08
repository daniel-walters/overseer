import { homedir } from "node:os";
import { join } from "node:path";
import { installSkills } from "./installSkills.js";
import { resolveSkillsSource } from "./resolveSkillsSource.js";

/** Options for {@link runInit}; defaults point at the real environment. */
export interface RunInitOptions {
  /** Entry file URL used to locate the shipped `skills/`. Defaults to the CLI's. */
  entryUrl: string;
  /** Home directory; used to derive the default Claude skills root. */
  home?: string;
  /** Sink for the user-facing summary. Defaults to stdout. */
  write?: (text: string) => void;
}

/**
 * Resolve the global Claude skills root, honoring a relocated config dir.
 *
 * Claude Code discovers skills under `$CLAUDE_CONFIG_DIR ?? <home>/.claude` →
 * `skills/`, so `init` installs there rather than a hardcoded `~/.claude`.
 * An empty `$CLAUDE_CONFIG_DIR` (e.g. `export CLAUDE_CONFIG_DIR=`) is treated as
 * unset — falling back to `~/.claude` — rather than as a cwd-relative path.
 */
function skillsTarget(home: string): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = override ? override : join(home, ".claude");
  return join(configDir, "skills");
}

/**
 * Thin onboarding orchestrator for `overseer init`.
 *
 * Resolves the shipped `skills/` source, installs every bundled skill into the
 * global Claude skills root, and prints a summary naming what was installed.
 */
export function runInit(options: RunInitOptions): void {
  const home = options.home ?? homedir();
  const write = options.write ?? ((text) => process.stdout.write(text));

  const source = resolveSkillsSource(options.entryUrl);
  const target = skillsTarget(home);
  const installed = installSkills({ source, target });

  const lines = [
    `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"} into ${target}:`,
    ...installed.map((name) => `  - ${name}`),
  ];
  write(lines.join("\n") + "\n");
}
