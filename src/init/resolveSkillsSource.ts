import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the shipped `skills/` directory relative to the entry file.
 *
 * The entry file (`cli.js`) lives one level below the package root — in `dist/`
 * when built, or at the repo root's `src/` when run via `tsx` — and `skills/`
 * ships alongside that root. So `skills/` is one level up from the entry file's
 * directory. Resolving from `import.meta.url` (passed in as `entryUrl`) rather
 * than the current working directory makes the source identical whether Overseer
 * runs from source, from `dist/`, or from a globally-installed npm package.
 */
export function resolveSkillsSource(entryUrl: string): string {
  const entryDir = dirname(fileURLToPath(entryUrl));
  return join(entryDir, "..", "skills");
}
