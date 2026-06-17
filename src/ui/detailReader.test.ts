import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDetailReader } from "./detailReader.js";

/**
 * The detail seam is the data behind the `v` detail modal: on demand it resolves
 * the selected card's file off disk, strips its frontmatter, and returns
 * `{ title, body }` — or `undefined` when the file is gone. At board level it
 * reads the PRD's `prd.md`; zoomed, it reads the selected Issue's file. One seam,
 * both levels. It is shaped like the preview seams (`readOpenPr`, `readKill`,
 * `readReviewTarget`): a pure resolve-from-selection with no UI, no writes, and no
 * touch on `scanBoard` or the `Board` model (the body is never carried in it).
 *
 * Tested directly against the shared `src/__fixtures__/board` tree (prior art:
 * `openPr.test.ts`, the `reader` / `reviewReader` seam tests), which already holds
 * PRDs with bodies, an empty-body Issue, and a malformed-frontmatter Issue.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "board",
);

const reader = createDetailReader(FIXTURES);

describe("readDetail at board level", () => {
  it("resolves the PRD's prd.md into its title and frontmatter-stripped body", () => {
    const detail = reader.readDetail("auth-system");

    expect(detail?.title).toBe("Authentication System");
    expect(detail?.body).toContain("Let users sign in.");
    // The YAML frontmatter block is stripped — no fences, no status leak.
    expect(detail?.body).not.toContain("---");
    expect(detail?.body).not.toContain("status:");
  });

  it("returns undefined when the PRD directory has vanished", () => {
    expect(reader.readDetail("gone")).toBeUndefined();
  });
});

describe("readDetail when zoomed into an Issue", () => {
  it("resolves the selected Issue file (not the PRD) into its title and body", () => {
    const detail = reader.readDetail("auth-system", "001-password-hashing.md");

    expect(detail?.title).toBe("Password hashing");
    expect(detail?.body).toContain("Hash passwords with a modern KDF.");
    expect(detail?.body).not.toContain("status:");
    // It read the Issue, not the PRD body.
    expect(detail?.body).not.toContain("Let users sign in.");
  });

  it("returns undefined when the selected Issue file has vanished", () => {
    expect(reader.readDetail("auth-system", "999-gone.md")).toBeUndefined();
  });

  it("returns undefined when the whole PRD directory has vanished", () => {
    expect(reader.readDetail("gone", "001-password-hashing.md")).toBeUndefined();
  });
});

describe("readDetail degenerate cases", () => {
  it("returns a defined result with a blank body for an empty-body file", () => {
    // Frontmatter only, no content beneath — the modal shows its placeholder, so
    // this must be a defined result, not the missing-file `undefined`.
    const detail = reader.readDetail("empty-body", "001-no-body.md");

    expect(detail).toBeDefined();
    expect(detail?.title).toBe("No body");
    expect(detail?.body.trim()).toBe("");
  });

  it("returns the raw content as the body for a malformed-frontmatter file", () => {
    // Where the underlying parse falls back to `{ data: {}, content: raw }`, the
    // user investigating a `⚠ bad status` card wants to see the raw file.
    const detail = reader.readDetail("malformed-fm", "001-malformed.md");

    expect(detail).toBeDefined();
    // The raw file (fences and all) is the body, since there is no parsed title.
    expect(detail?.body).toContain("---");
    expect(detail?.body).toContain("deviation: had to do this: because reasons");
    expect(detail?.body).toContain("The raw body the user needs to see.");
    // No parsed title, so it falls back to the filename.
    expect(detail?.title).toBe("001-malformed.md");
  });
});
