import { join } from "node:path";
import { readDispatchIssue } from "./reader.js";
import { writeStatus as realWriteStatus } from "../issueFile.js";
import type { MarkDone } from "../ui/App.js";
import type { MarkDonePreviewData } from "../ui/MarkDonePreview.js";

/**
 * Mark done: the `ready-for-human`-gated, confirm-previewed board action that
 * advances a human-held Issue straight to `done` (CONTEXT.md → mark done). This
 * is the board's **first human-triggered status flip with no spawn behind it** — a
 * deliberate, gated exception to the read-only-viewer contract (ADR 0002), the
 * same way Delete PRD is: every other status write either flips-before-a-spawn as
 * an idempotency lock (`d`/`r`) or is an agent writing its own transition. `m` is
 * a new actor on the Issue file, but a cheap and reversible one — a single status
 * flip a human can undo by re-editing the field — so its confirm is an "is the
 * manual work actually finished?" intent beat, not a safety net against
 * irreversibility.
 *
 * This module is the deep module behind that action, **thinner than its
 * review/delete twins** ({@link import("../review/reviewer.js").createReviewer},
 * {@link import("./deletePrd.js").createDelete}): there is no external state
 * (git/gh) to resolve, so the preview is purely the confirm copy (the Issue title
 * + its file path). On confirm it writes `status: done` through the injectable
 * {@link MarkDoneDeps.writeStatus} edge — reusing the existing `writeStatus`
 * primitive unchanged, the same writer the dispatch/review rollback paths call.
 * The watcher's re-scan then moves the card to the `done` column (no special
 * handling needed).
 *
 * Both entry points are total, like the reviewer's: the root is filesystem-watched
 * and changes under the TUI by design, so `m` and confirm can race a deletion.
 * `readMarkDone` reports a vanished PRD/Issue as `undefined` (the preview renders
 * nothing) rather than letting an exception escape the Ink input handler.
 */

/** The seams the mark-done orchestration depends on (injected for tests). */
export interface MarkDoneDeps {
  /**
   * Read one Issue file in a PRD directory into its title + path — the two facts
   * the preview names. The default reuses the dispatch reader so mark-done parses
   * Issue frontmatter identically to every other edge; a test fake answers from
   * in-memory state. Throws if the Issue vanished mid-action.
   */
  readonly readIssue: (
    prdDir: string,
    issueId: string,
  ) => { readonly id: string; readonly title: string; readonly path: string };
  /**
   * Write `status` to an Issue file in place. The default is the real
   * `writeStatus` primitive (a surgical single-line frontmatter edit, comments
   * preserved); a test fake records the call. The one mutation this action makes.
   */
  readonly writeStatus: (path: string, status: string) => void;
}

/** The production deps: the real dispatch reader + the real `writeStatus`. */
export function realMarkDoneDeps(): MarkDoneDeps {
  return {
    readIssue: (prdDir, issueId) => readDispatchIssue(prdDir, issueId),
    writeStatus: realWriteStatus,
  };
}

/**
 * Build the production {@link MarkDone} the App drives at the Issue level. It
 * resolves a (PRD id, Issue id) to a {@link MarkDonePreviewData} (title + path)
 * and, on confirm, writes `status: done` to that path. No spawn, no rollback, no
 * external query — the thinnest of the Issue-level seams.
 */
export function createMarkDone(root: string, deps: MarkDoneDeps): MarkDone {
  return {
    readMarkDone(prdId: string, issueId: string): MarkDonePreviewData | undefined {
      const prdDir = join(root, prdId);
      try {
        const issue = deps.readIssue(prdDir, issueId);
        return { issueTitle: issue.title, issuePath: issue.path };
      } catch {
        // The PRD dir or the Issue file vanished from the watched root.
        return undefined;
      }
    },

    markDone(preview: MarkDonePreviewData): void {
      deps.writeStatus(preview.issuePath, "done");
    },
  };
}
