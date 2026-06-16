import { join } from "node:path";
import { readDispatchIssue, readPrdMeta } from "../dispatch/reader.js";

/**
 * The data seam behind the `v` detail modal: on demand, resolve the selected
 * card's file off disk, strip its frontmatter, and return `{ title, body }` — or
 * `undefined` when the file is gone. At board level it reads the PRD's `prd.md`;
 * zoomed, it reads the selected Issue's file. One seam serves both levels.
 *
 * It is the deepest module of the detail-modal feature (the modal and scrolling
 * slices render from it), shaped like the existing preview seams (`readOpenPr`,
 * `readKill`, `readReviewTarget`): a pure resolve-from-selection with no UI, no
 * writes, and no change to `scanBoard` or the `Board` model. The body is **never**
 * carried in the model (ADR 0003) — it is read lazily, here, when the modal opens,
 * so the modal always shows the file's *current* content and no re-scan holds every
 * body in memory.
 *
 * The frontmatter-stripping, the title fallback, and the malformed-frontmatter
 * raw-content fallback are not re-derived: this seam reuses the dispatch reader's
 * `readPrdMeta` / `readDispatchIssue`, which already parse through the shared
 * `safeMatter` access layer (so the format is known in exactly one place,
 * `issueFile.ts`). The degenerate cases fall out of that reuse:
 *
 * - **Empty body** (frontmatter only) → `safeMatter` yields blank `content`, so the
 *   result is *defined* with a blank body and the modal shows its placeholder.
 * - **Missing file** (deleted between the last scan and the keypress) → the
 *   underlying read throws and we return `undefined` (the modal slice makes the
 *   keybind a no-op on `undefined`), exactly as the preview seams degrade a
 *   vanished target. Never an exception out of the Ink input handler.
 * - **Malformed frontmatter** (where `safeMatter` falls back to `{ data: {},
 *   content: raw }`) → the raw file is the body, since a user investigating a
 *   `⚠ bad status` card wants to see the malformed frontmatter they must fix.
 */

/**
 * One card's body resolved for the detail modal: the display title and the
 * frontmatter-stripped markdown body. The body may be blank (the empty-body case);
 * a *missing* file is the seam's `undefined`, not a blank {@link CardDetail}.
 */
export interface CardDetail {
  /** Display title: `title` frontmatter, falling back to the dir/file name. */
  readonly title: string;
  /** The markdown body with the YAML frontmatter block stripped. */
  readonly body: string;
}

/**
 * The App-facing detail seam, bound to the watched `root`. `readDetail` resolves
 * the selected card's body on demand: with only a `prdId` (board level) it reads
 * the PRD's `prd.md`; with an `issueId` too (zoomed) it reads that Issue file.
 */
export interface DetailReader {
  readonly readDetail: (prdId: string, issueId?: string) => CardDetail | undefined;
}

/**
 * Build the production {@link DetailReader} bound to a watched `root`. `readDetail`
 * joins `root` + the PRD id (and, when zoomed, the Issue id) to the file to read,
 * then projects it to `{ title, body }`. Total: the root is filesystem-watched and
 * changes under the TUI, so a `v` press can race a deletion — a vanished PRD dir or
 * Issue file yields `undefined` rather than letting an exception escape, mirroring
 * `readReviewTarget` / `createOpenPr`.
 */
export function createDetailReader(root: string): DetailReader {
  return {
    readDetail(prdId: string, issueId?: string): CardDetail | undefined {
      const prdDir = join(root, prdId);
      try {
        if (issueId === undefined) {
          // Board level: the PRD's `prd.md`.
          const { prdTitle, prdBody } = readPrdMeta(prdDir);
          return { title: prdTitle, body: prdBody };
        }
        // Zoomed: the selected Issue's file.
        const issue = readDispatchIssue(prdDir, issueId);
        return { title: issue.title, body: issue.body };
      } catch {
        // The PRD dir, its `prd.md`, or the Issue file vanished from the watched
        // root between the last scan and this keypress — a harmless no-op.
        return undefined;
      }
    },
  };
}
