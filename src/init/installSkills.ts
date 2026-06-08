import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Options for {@link installSkills}; source and target are injected for testing. */
export interface InstallSkillsOptions {
  /** Directory holding the bundled skill subdirectories (the shipped `skills/`). */
  source: string;
  /** Global Claude skills root to install into (e.g. `~/.claude/skills`). */
  target: string;
}

/**
 * Install every bundled skill into the global Claude skills root.
 *
 * A bundled skill is any immediate subdirectory of `source` that contains a
 * `SKILL.md` — the same "a directory with a marker file *is* the entity" rule
 * Overseer uses for PRDs. Each skill is installed via a per-skill
 * **remove-then-copy**: `<target>/<skill>` is deleted, then the source skill
 * directory is recursively copied into its place, so the installed copy is an
 * exact mirror (no stale orphans). The deletion is scoped strictly to each
 * individual skill directory — never `target` itself — so unrelated user skills
 * are untouched. The target root is created if absent.
 *
 * Returns the names of the installed skills.
 */
export function installSkills(options: InstallSkillsOptions): string[] {
  const { source, target } = options;

  mkdirSync(target, { recursive: true });

  const names = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(source, name, "SKILL.md")))
    .sort();

  for (const name of names) {
    const dest = join(target, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(source, name), dest, { recursive: true });
  }

  return names;
}
