import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The canonical "is this directory a PRD?" rule, factored out so the scanner,
 * the dispatcher, and the Reactor's cross-PRD sweep all agree on what counts as
 * a PRD rather than each re-deriving it: a directory is a PRD exactly when it
 * contains a `prd.md` (CONTEXT.md / scanner discovery rule).
 */
export function isPrdDir(dir: string): boolean {
  return existsSync(join(dir, "prd.md"));
}

/**
 * Enumerate every PRD directory directly under `root`: each subdirectory that
 * contains a `prd.md` (via {@link isPrdDir}), as an absolute path. Loose files
 * in the root and directories without a `prd.md` are ignored.
 *
 * Total, like the rest of the Reactor: the root is filesystem-watched and may be
 * deleted or replaced under the live board, so an unreadable/missing root yields
 * no PRDs rather than throwing out of the watcher callback and crashing the
 * board. A directory that vanishes between this listing and a later read is the
 * reader's concern (the sweep skips it), not this enumerator's.
 */
export function enumeratePrdDirs(root: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // the watched root vanished or is unreadable
  }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .filter(isPrdDir);
}
