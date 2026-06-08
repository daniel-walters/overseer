import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "./installSkills.js";

let source: string;
let target: string;

/** Create a skill directory under `dir` with a SKILL.md and any extra files. */
function writeSkill(
  dir: string,
  name: string,
  files: Record<string, string> = {},
): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(skillDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

beforeEach(() => {
  // A throwaway source tree and target root so filesystem effects are isolated.
  source = mkdtempSync(join(tmpdir(), "overseer-skills-src-"));
  target = mkdtempSync(join(tmpdir(), "overseer-skills-dst-"));
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("installSkills", () => {
  it("copies a source skill (with companion files) into the target root", () => {
    writeSkill(source, "overseer-to-prd", {
      "reference.md": "companion\n",
      "lib/helper.txt": "nested\n",
    });

    const installed = installSkills({ source, target });

    expect(installed).toEqual(["overseer-to-prd"]);
    expect(readFileSync(join(target, "overseer-to-prd", "SKILL.md"), "utf8")).toBe(
      "# overseer-to-prd\n",
    );
    expect(
      readFileSync(join(target, "overseer-to-prd", "reference.md"), "utf8"),
    ).toBe("companion\n");
    expect(
      readFileSync(join(target, "overseer-to-prd", "lib", "helper.txt"), "utf8"),
    ).toBe("nested\n");
  });

  it("ignores source subdirectories that lack a SKILL.md", () => {
    writeSkill(source, "overseer-to-prd");
    // A bare directory with no SKILL.md is not a skill and must not be installed.
    mkdirSync(join(source, "not-a-skill"), { recursive: true });
    writeFileSync(join(source, "not-a-skill", "notes.md"), "ignore me\n");

    const installed = installSkills({ source, target });

    expect(installed).toEqual(["overseer-to-prd"]);
    expect(existsSync(join(target, "not-a-skill"))).toBe(false);
  });

  it("creates the target root when it does not yet exist", () => {
    writeSkill(source, "overseer-to-prd");
    const missingTarget = join(target, "does", "not", "exist", "skills");

    const installed = installSkills({ source, target: missingTarget });

    expect(installed).toEqual(["overseer-to-prd"]);
    expect(existsSync(join(missingTarget, "overseer-to-prd", "SKILL.md"))).toBe(
      true,
    );
  });

  it("is an exact mirror: a companion file removed upstream does not survive a re-run", () => {
    writeSkill(source, "overseer-to-prd", { "stale.md": "old\n" });
    installSkills({ source, target });
    expect(existsSync(join(target, "overseer-to-prd", "stale.md"))).toBe(true);

    // Drop the companion file from the source, then re-install.
    rmSync(join(source, "overseer-to-prd", "stale.md"));
    installSkills({ source, target });

    expect(existsSync(join(target, "overseer-to-prd", "stale.md"))).toBe(false);
    expect(existsSync(join(target, "overseer-to-prd", "SKILL.md"))).toBe(true);
  });

  it("fully replaces a pre-existing installed copy", () => {
    // A stale installed copy with different content already exists.
    mkdirSync(join(target, "overseer-to-prd"), { recursive: true });
    writeFileSync(join(target, "overseer-to-prd", "SKILL.md"), "STALE\n");
    writeFileSync(join(target, "overseer-to-prd", "orphan.md"), "orphan\n");
    writeSkill(source, "overseer-to-prd");

    installSkills({ source, target });

    expect(readFileSync(join(target, "overseer-to-prd", "SKILL.md"), "utf8")).toBe(
      "# overseer-to-prd\n",
    );
    expect(existsSync(join(target, "overseer-to-prd", "orphan.md"))).toBe(false);
  });

  it("scopes deletion to each skill dir, leaving an unrelated sibling untouched", () => {
    // A user's own skill already lives in the target root.
    mkdirSync(join(target, "my-own-skill"), { recursive: true });
    writeFileSync(join(target, "my-own-skill", "SKILL.md"), "mine\n");
    writeSkill(source, "overseer-to-prd");

    installSkills({ source, target });

    // The Overseer skill is installed; the unrelated sibling is left intact.
    expect(existsSync(join(target, "overseer-to-prd", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(target, "my-own-skill", "SKILL.md"), "utf8")).toBe(
      "mine\n",
    );
  });

  it("returns every installed skill name", () => {
    writeSkill(source, "overseer-to-prd");
    writeSkill(source, "overseer-to-issues");
    writeSkill(source, "overseer-grill-with-docs");

    const installed = installSkills({ source, target });

    expect(installed.sort()).toEqual([
      "overseer-grill-with-docs",
      "overseer-to-issues",
      "overseer-to-prd",
    ]);
  });
});
