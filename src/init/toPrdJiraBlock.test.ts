import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeMatter, parseJiraOptIn } from "../issueFile.js";

/**
 * The shipped `overseer-to-prd` skill authors the `jira` opt-in block into a new
 * `prd.md` (JIRA Mirror). These tests defend the seam between *authoring* (the
 * skill's prose) and *reading*: `board` and `project` are run through the real
 * parser (slice 001's `parseJiraOptIn`), so drift in those spellings fails here
 * instead of silently producing a `jira` block the mirror can't act on. `target`
 * has no parser yet — sprint/backlog placement is a later slice — so its test
 * only pins the field's spelling and legal values in the authored YAML, and the
 * config key test only pins `default_board`'s spelling in the skill's prose.
 */
const skillMd = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "overseer-to-prd",
  "SKILL.md",
);

/**
 * Pull the fenced code block that immediately follows the
 * `<!-- jira-block-example -->` marker out of the skill — the single canonical
 * `jira` block the skill instructs the agent to write.
 */
function readJiraBlockExample(): string {
  const text = readFileSync(skillMd, "utf8");
  const body = text.match(
    /<!-- jira-block-example -->\s*```[a-z]*\n([\s\S]*?)```/,
  )?.[1];
  if (body === undefined) {
    throw new Error(
      "overseer-to-prd SKILL.md is missing the <!-- jira-block-example --> fenced block",
    );
  }
  return dedent(body);
}

/**
 * The example is fenced inside a numbered list, so every line is indented; strip
 * the common leading whitespace so the `---` fences sit at column 0 and
 * gray-matter recognises the frontmatter.
 */
function dedent(block: string): string {
  const lines = block.split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)![0].length);
  const common = Math.min(...indents);
  return lines.map((line) => line.slice(common)).join("\n");
}

describe("overseer-to-prd jira block", () => {
  it("ships a canonical jira block the slice 001 parser accepts as an opt-in", () => {
    const { data } = safeMatter(readJiraBlockExample());

    // Presence of the block is the opt-in; the parser must return a defined
    // JiraOptIn, not undefined.
    expect(parseJiraOptIn(data)).toBeDefined();
  });

  it("authors the board field under the exact spelling the parser reads", () => {
    const { data } = safeMatter(readJiraBlockExample());

    // No drift: the board the skill writes is the board the mirror resolves.
    expect(parseJiraOptIn(data)?.board).toBeTruthy();
  });

  it("authors the sprint-or-backlog target field on the block", () => {
    const example = readJiraBlockExample();
    const { data } = safeMatter(example);

    // `target: sprint|backlog` has no parser yet (deferred to the sprint/backlog
    // placement slice); the skill must still emit it under this locked spelling
    // with a legal value so that slice can read it verbatim once it lands.
    const jira = data.jira as Record<string, unknown>;
    expect(["sprint", "backlog"]).toContain(jira.target);
  });

  it("documents the config-defaulted board question against the real config key", () => {
    // The board question is defaulted from `default_board` — the exact key
    // `config.ts` parses out of the `[jira]` table.
    expect(readFileSync(skillMd, "utf8")).toContain("default_board");
  });
});
