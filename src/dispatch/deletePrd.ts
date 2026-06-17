import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { readDispatchView } from "./reader.js";
import { errorMessage } from "../errorMessage.js";
import type { Delete } from "../ui/App.js";

/**
 * Delete PRD: the `done`-gated, confirm-previewed board action that removes a
 * finished PRD's whole directory (`prd.md`, every Issue file, and any other file
 * in it) from the watched root in one gesture. This is the board's **first
 * destructive write to the root** — a deliberate, ADR-0016-recorded exception to
 * the read-only-viewer contract (ADR 0002): every other root write is a status
 * flip or an agent writing its own file; this is the first *removal* of domain
 * data.
 *
 * This module is the deep module behind that action, mirroring the structure of
 * {@link import("./openPr.js").openPrFor}: given a `done` PRD's directory it
 * builds a delete **preview** (the PRD title + the count of Issue files that will
 * be removed) and, on confirm, removes the directory wholesale through the
 * injectable {@link DeleteSeam} — a single `removeDir(path)` edge wrapping
 * `fs.rmSync(path, { recursive: true, force: true })`. The unit is the whole
 * directory, never a selective sweep; the deleted Issues' liveness sidecar
 * entries are left dangling-but-inert (the sidecar is read only as a join onto
 * scanned Issues), the same way the suppressed failed-set tolerates stale entries.
 *
 * Total by construction: a PRD directory that vanished mid-action, or a removal
 * that throws (permissions), resolves to a failed {@link DeleteResult} carrying a
 * human-readable reason — never a throw out of the Ink input handler, so a failure
 * surfaces loudly in the status line rather than crashing the board.
 */

/**
 * The single filesystem edge the delete orchestration drives: remove a directory
 * and everything under it. The real seam wraps `fs.rmSync(path, { recursive:
 * true, force: true })` ({@link realDeleteDeps}); a test fake records the call and
 * can be scripted to throw. The board's first *destructive* root edge, kept as
 * narrow as the `gh`/`git` write seams so the whole orchestration is unit-tested
 * with an in-memory fake and no real removal.
 */
export interface DeleteSeam {
  /** Remove `path` and all its contents. Throws on failure (e.g. permissions). */
  removeDir(path: string): void;
}

/** The seams + per-PRD Issue count the delete orchestration depends on. */
export interface DeleteDeps {
  /** Remove a directory (default: real `fs.rmSync` recursive+force). */
  readonly seam: DeleteSeam;
  /**
   * Count the Issue files in a PRD directory — what the preview names so the user
   * sees how many Issues the delete destroys. The default reads the PRD's Issue
   * files (the same scan the dispatch reader does); a test fake answers from
   * in-memory state. Throws if the PRD vanished mid-action.
   */
  readonly countIssues: (prdDir: string) => number;
}

/**
 * The frozen plan a Delete confirm acts on, and what the confirm modal renders
 * ({@link import("../ui/DeletePreview.js").DeletePreview}). Built by
 * {@link createDelete.readDelete} when `X` is pressed on a `done` PRD, captured
 * outside the App's nav reducer so a live re-scan under the modal can't re-point
 * it at another PRD (mirroring the Open PR / dispatch / review captures).
 */
export interface DeletePreviewData {
  /** The PRD being deleted, named so the user can catch a wrong target. */
  readonly prdTitle: string;
  /** How many Issue files the delete will remove — the gravity of the action. */
  readonly issueCount: number;
}

/**
 * The outcome of a Delete action: success, or a human-readable `error` the App
 * surfaces loudly in the status line. Mirrors {@link import("./openPr.js").OpenPrResult}
 * so the two destructive-action results read the same.
 */
export type DeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Run the Delete action for one `done` PRD's directory: remove the whole
 * directory wholesale through the seam. Never throws — a removal that fails
 * (permissions, a folder that vanished mid-action) comes back as a failed
 * {@link DeleteResult}.
 *
 * The caller (the App) gates this to `done` PRDs; this function does not re-check
 * the column (it has only the directory), so an off-`done` no-op is the App's
 * concern, exactly as `P`/Open PR gates its level before calling its orchestration.
 */
export function deletePrdAt(prdDir: string, deps: DeleteDeps): DeleteResult {
  try {
    // The unit is the whole directory, removed wholesale (recursive + force),
    // including any non-Issue files — never a selective sweep.
    deps.seam.removeDir(prdDir);
    return { ok: true };
  } catch (err) {
    // A removal failure (permissions, a folder that vanished mid-action) surfaces
    // loudly in the status line, like a spawn failure — never a crash.
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Build the App-facing {@link Delete} seam bound to a watched `root` and the given
 * deps. `readDelete` joins `root` + the PRD id to its directory and resolves the
 * preview (title + Issue-file count); `delete` runs {@link deletePrdAt} over the
 * PRD on confirm.
 *
 * Both entry points are total: the root is filesystem-watched and changes under
 * the TUI, so `X` and confirm can race a deletion. `readDelete` reports a vanished
 * PRD as no preview (nothing opens), and `delete` reports any failure as a failed
 * {@link DeleteResult} — neither throws out of the Ink input handler.
 */
export function createDelete(root: string, deps: DeleteDeps): Delete {
  return {
    readDelete(prdId: string): DeletePreviewData | undefined {
      const prdDir = join(root, prdId);
      try {
        return { prdTitle: basename(prdDir), issueCount: deps.countIssues(prdDir) };
      } catch {
        return undefined; // PRD dir/files vanished from the watched root
      }
    },

    delete(preview: DeletePreviewData): DeleteResult {
      return deletePrdAt(join(root, preview.prdTitle), deps);
    },
  };
}

/**
 * The production `countIssues`: the number of Issue files in a PRD directory. Reads
 * the PRD's Issue files via the dispatch reader — the same scan dispatch counts —
 * so the preview's count matches what dispatch sees. Throws if the PRD vanished
 * mid-action, which `readDelete` catches and degrades to no preview.
 */
export function realCountIssues(prdDir: string): number {
  return readDispatchView(prdDir).issues.length;
}

/**
 * Build the production Delete dependencies wired to the real `fs` removal seam and
 * the real per-PRD Issue count — the ones the CLI passes through to the App. A thin
 * convenience so the wiring site need not name both default seams, mirroring
 * {@link import("./openPr.js").realOpenPrDeps}.
 */
export function realDeleteDeps(): DeleteDeps {
  return {
    seam: {
      // The board's first destructive root edge. `recursive` so the whole tree
      // goes (not just an empty dir), `force` so a concurrent out-of-band removal
      // (the folder already vanished) is not itself an error — the action is
      // idempotent against a racing delete. The un-fakeable `fs` boundary, kept
      // thin and excluded from unit tests like the `git`/`gh` shell-outs.
      removeDir: (path: string) => rmSync(path, { recursive: true, force: true }),
    },
    countIssues: realCountIssues,
  };
}
