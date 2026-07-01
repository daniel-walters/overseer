import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIELD,
  hasValue,
  readPresentString,
  readString,
  safeMatter,
  writeStatus,
  writeHumanReview,
  parseJiraOptIn,
  writeJiraEpic,
  writeJiraKey,
} from "./issueFile.js";

describe("safeMatter", () => {
  it("parses frontmatter and strips it from the body", () => {
    const { data, content } = safeMatter("---\ntitle: Hi\nstatus: backlog\n---\n\nBody.\n");
    expect(data.title).toBe("Hi");
    expect(data.status).toBe("backlog");
    expect(content.trim()).toBe("Body.");
  });

  it("treats malformed YAML as no frontmatter, keeping the raw text as body", () => {
    // An unquoted value containing ": " is the agent-written failure mode the
    // defensive parse exists for — it must not throw.
    const raw = "---\ndeviation: had to do this: because reasons\n---\n\nBody.\n";
    const { data, content } = safeMatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });
});

describe("readString", () => {
  it("returns a string value, and undefined for missing or non-string fields", () => {
    const data = { title: "Hi", count: 3, blank: "" };
    expect(readString(data, "title")).toBe("Hi");
    expect(readString(data, "count")).toBeUndefined();
    expect(readString(data, "absent")).toBeUndefined();
  });

  it("keeps a blank string verbatim (does not collapse it)", () => {
    expect(readString({ status: "" }, "status")).toBe("");
  });
});

describe("hasValue / readPresentString", () => {
  it("hasValue is false for undefined, blank, and whitespace-only", () => {
    expect(hasValue(undefined)).toBe(false);
    expect(hasValue("")).toBe(false);
    expect(hasValue("   ")).toBe(false);
    expect(hasValue("x")).toBe(true);
  });

  it("readPresentString collapses a blank field to undefined", () => {
    expect(readPresentString({ deviation: "" }, "deviation")).toBeUndefined();
    expect(readPresentString({ deviation: "  " }, "deviation")).toBeUndefined();
    expect(readPresentString({ deviation: "strayed" }, "deviation")).toBe("strayed");
    expect(readPresentString({}, "deviation")).toBeUndefined();
  });
});

describe("FIELD", () => {
  it("uses the on-disk snake_case spelling for multi-word fields", () => {
    expect(FIELD.blockedBy).toBe("blocked_by");
    expect(FIELD.humanReviewReason).toBe("human_review_reason");
  });
});

/**
 * `writeStatus` is the dispatcher's one allowed mutation of an Issue file: it
 * rewrites just the `status` frontmatter and leaves everything else — the other
 * frontmatter keys, key order where practical, and the entire body — as
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

describe("writeHumanReview", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-human-review-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("sets human-review with the reason and note in one write, preserving other fields", () => {
    const path = file(
      "issue.md",
      `---
title: Non-converging
status: in-review
repo: /repos/backend
worktree: /wt/x
branch: feat-x
---

The body survives.
`,
    );

    writeHumanReview(path, "non-convergence", "ran out of road after 3 passes");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("human_review_reason: non-convergence");
    expect(after).toContain("ran out of road after 3 passes");
    // The handoff fields and the body are preserved.
    expect(after).toContain("repo: /repos/backend");
    expect(after).toContain("worktree: /wt/x");
    expect(after).toContain("branch: feat-x");
    expect(after).toContain("The body survives.");
  });

  it("keeps an implementor deviation field intact (the audit trail)", () => {
    const path = file(
      "issue.md",
      `---
title: Strayed
status: in-review
repo: /repos/backend
deviation: "swapped the parser library"
---

Body.
`,
    );

    writeHumanReview(path, "non-convergence", "did not converge");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("status: human-review");
    expect(after).toContain("swapped the parser library");
  });
});

describe("parseJiraOptIn", () => {
  it("returns undefined when the file carries no jira block (not opted in)", () => {
    const { data } = safeMatter("---\ntitle: Private\n---\n\nBody.\n");
    expect(parseJiraOptIn(data)).toBeUndefined();
  });

  it("reads board and project from a full jira block", () => {
    const { data } = safeMatter(
      '---\ntitle: X\njira:\n  board: "42"\n  project: "PROJ"\n---\n',
    );
    expect(parseJiraOptIn(data)).toEqual({ board: "42", project: "PROJ" });
  });

  it("reads a board-only block, leaving project undefined", () => {
    const { data } = safeMatter('---\njira:\n  board: "42"\n---\n');
    expect(parseJiraOptIn(data)).toEqual({ board: "42" });
  });

  it("treats a present-but-empty jira block as opt-in with no fields", () => {
    // The block's *presence* is the opt-in; an empty one defers board to config.
    const { data } = safeMatter("---\ntitle: X\njira:\n---\n");
    expect(parseJiraOptIn(data)).toEqual({});
  });

  it("coerces a numeric board id to a string", () => {
    const { data } = safeMatter("---\njira:\n  board: 42\n---\n");
    expect(parseJiraOptIn(data)).toEqual({ board: "42" });
  });

  it("drops blank board/project values to undefined", () => {
    const { data } = safeMatter('---\njira:\n  board: ""\n  project: "  "\n---\n');
    expect(parseJiraOptIn(data)).toEqual({});
  });
});

describe("writeJiraEpic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-jira-epic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("writes the jira_epic backref, preserving the jira block and body", () => {
    const path = file(
      "prd.md",
      `---
title: Auth
jira:
  board: "42"
---

The plan.
`,
    );

    writeJiraEpic(path, "PROJ-100");

    const after = readFileSync(path, "utf8");
    expect(after).toContain("jira_epic: PROJ-100");
    expect(after).toContain("title: Auth");
    // The opt-in block survives the write-back.
    expect(after).toContain("board:");
    expect(after).toContain("The plan.");
    // Reading it back yields the key we wrote.
    expect(readPresentString(safeMatter(after).data, FIELD.jiraEpic)).toBe(
      "PROJ-100",
    );
  });

  it("overwrites an existing jira_epic value rather than adding a second", () => {
    const path = file(
      "prd.md",
      `---
title: Auth
jira_epic: PROJ-1
---

Body.
`,
    );

    writeJiraEpic(path, "PROJ-2");

    const after = readFileSync(path, "utf8");
    expect(readPresentString(safeMatter(after).data, FIELD.jiraEpic)).toBe(
      "PROJ-2",
    );
    // Exactly one jira_epic key.
    expect(after.match(/jira_epic/g)).toHaveLength(1);
  });
});

describe("writeJiraKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overseer-jira-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("writes the jira_key backref onto an Issue, preserving status, other keys, and body", () => {
    const path = file(
      "001-auth.md",
      `---
title: Login form
status: in-progress
blocked_by:
  - 000-schema.md
---

The human-readable plan prose.
`,
    );

    writeJiraKey(path, "DS-101");

    const after = readFileSync(path, "utf8");
    expect(readPresentString(safeMatter(after).data, FIELD.jiraKey)).toBe(
      "DS-101",
    );
    // The Issue's own content is untouched — the backref is the mirror's only reach.
    expect(after).toContain("status: in-progress");
    expect(after).toContain("title: Login form");
    expect(after).toContain("000-schema.md");
    expect(after).toContain("The human-readable plan prose.");
  });

  it("overwrites an existing jira_key value rather than adding a second", () => {
    const path = file(
      "001-auth.md",
      `---
title: Login form
status: done
jira_key: DS-1
---

Body.
`,
    );

    writeJiraKey(path, "DS-2");

    const after = readFileSync(path, "utf8");
    expect(readPresentString(safeMatter(after).data, FIELD.jiraKey)).toBe("DS-2");
    expect(after.match(/jira_key/g)).toHaveLength(1);
  });
});
