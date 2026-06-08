import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStatus } from "./statusWriter.js";

/**
 * The status-writer is the dispatcher's one allowed mutation of an Issue file:
 * it rewrites just the `status` frontmatter and leaves everything else — the
 * other frontmatter keys, key order where practical, and the entire body — as
 * authored. These tests assert that external behaviour over a real temp file.
 */
describe("writeStatus", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-status-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("flips the status while preserving the other frontmatter and the body", () => {
    const path = file(
      "issue.md",
      `---
title: Spawnable
status: ready-for-agent
repo: /repos/backend
blocked_by: [001-foundation.md]
---

The body. With a paragraph.

And another.
`,
    );

    writeStatus(path, "in-progress");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: in-progress");
    expect(after).not.toContain("ready-for-agent");
    // Everything else survives untouched.
    expect(after).toContain("title: Spawnable");
    expect(after).toContain("repo: /repos/backend");
    expect(after).toContain("blocked_by:");
    expect(after).toContain("The body. With a paragraph.");
    expect(after).toContain("And another.");
  });

  it("adds a status key when the frontmatter has none", () => {
    const path = file(
      "issue.md",
      `---
title: No status here
repo: /repos/backend
---

Body.
`,
    );

    writeStatus(path, "in-progress");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: in-progress");
    expect(after).toContain("title: No status here");
    expect(after).toContain("Body.");
  });

  it("preserves an inline comment on the status line and the rest verbatim", () => {
    const original = `---
title: Spawnable   # human-facing label
status: ready-for-agent  # waiting on the design sign-off
repo: /repos/backend
---

Body stays byte-for-byte.
`;
    const path = file("issue.md", original);

    writeStatus(path, "in-progress");

    const after = readFileSync(path, "utf8");
    // Only the status value changed; its trailing comment is kept.
    expect(after).toContain("status: in-progress  # waiting on the design sign-off");
    // Other lines' comments survive too (no full YAML re-dump).
    expect(after).toContain("title: Spawnable   # human-facing label");
    // The only difference from the original is the status value.
    expect(after).toBe(original.replace("ready-for-agent", "in-progress"));
  });

  it("round-trips a flip and a rollback to the same status string", () => {
    const path = file(
      "issue.md",
      `---
status: ready-for-agent
repo: /repos/backend
---

Body.
`,
    );

    writeStatus(path, "in-progress");
    expect(readFileSync(path, "utf8")).toContain("status: in-progress");

    writeStatus(path, "ready-for-agent");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: ready-for-agent");
    expect(after).not.toContain("in-progress");
  });
});
