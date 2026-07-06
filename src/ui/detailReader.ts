import { join } from "node:path";
import type { HumanReviewReason } from "../model.js";
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
  /**
   * The escalation reason for a `human-review` Issue, sourced from the **parsed
   * model field** (`Issue.humanReviewReason`) — not re-parsed from the file — so
   * the detail header reads from the same data that drives the card marker (ADR
   * 0014: the body comes from the file, this header from the model). Set by the
   * {@link App} only when zooming a `human-review` Issue that carries a note;
   * absent on a PRD's `prd.md` and on every non-`human-review` Issue, so the
   * detail view then shows the body alone, exactly as before.
   */
  readonly humanReviewReason?: HumanReviewReason;
  /**
   * The reviewer's free-text "why a human is needed" note, sourced from
   * `Issue.humanReviewNote` (the parsed model field). Paired with
   * {@link humanReviewReason} as the detail header block; absent when the Issue
   * carries no note (then no header renders, regardless of the reason).
   */
  readonly humanReviewNote?: string;
  /**
   * The free-text `review_tolerated` reason — *what* was tolerated at a
   * clean-with-tolerated merge (ADR 0027) — rendered as its own header block in
   * the detail view so a human viewing the Issue sees the findings that were waved
   * through, not just the board's presence-only `◌ tolerated` marker. Unlike
   * {@link humanReviewNote}, it is sourced from the *file* here (via
   * `readDispatchIssue`), because the parsed model only carries the boolean
   * {@link import("../model.js").Issue.tolerated}, never the reason text. Read
   * whenever present — not gated on the `done` lane the board marker uses — so the
   * audit-trail copy on a `human-review` Issue is visible too. Absent on a PRD's
   * `prd.md` and on any Issue with a blank/missing field (then no header renders).
   */
  readonly reviewTolerated?: string;
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
        // Zoomed: the selected Issue's file. `reviewTolerated` comes straight off
        // the file here (the model carries only the boolean marker), surfacing the
        // waved-through findings text in the detail view; `readPresentString` in
        // the dispatch reader already normalised a blank field to `undefined`.
        const issue = readDispatchIssue(prdDir, issueId);
        return { title: issue.title, body: issue.body, reviewTolerated: issue.reviewTolerated };
      } catch {
        // The PRD dir, its `prd.md`, or the Issue file vanished from the watched
        // root between the last scan and this keypress — a harmless no-op.
        return undefined;
      }
    },
  };
}
