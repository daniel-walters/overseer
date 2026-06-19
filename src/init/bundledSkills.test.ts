import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkills } from "./installSkills.js";

/** The repo's shipped `skills/` directory (two levels up from `src/init`). */
const shippedSkills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

describe("bundled skills", () => {
  it("installs overseer-merge from the shipped skills/ directory", () => {
    const target = mkdtempSync(join(tmpdir(), "overseer-bundled-"));
    try {
      const installed = installSkills({ source: shippedSkills, target });

      // The human-path merge skill must ship so `overseer init` installs it.
      expect(installed).toContain("overseer-merge");
      expect(existsSync(join(target, "overseer-merge", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("installs the overseer-tdd skill from the shipped skills/ directory", () => {
    const target = mkdtempSync(join(tmpdir(), "overseer-bundled-"));
    try {
      const installed = installSkills({ source: shippedSkills, target });

      // The implementor prompt names `overseer-tdd`, so a fresh `claude --bg` agent
      // can only load it if `init` ships and installs it alongside the other
      // overseer-* skills.
      expect(installed).toContain("overseer-tdd");
      expect(existsSync(join(target, "overseer-tdd", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("ships the overseer-to-prd commit-docs.sh script under scripts/", () => {
    const target = mkdtempSync(join(tmpdir(), "overseer-bundled-"));
    try {
      installSkills({ source: shippedSkills, target });

      // `installSkills` copies each skill directory recursively, so the bundled
      // `scripts/` subdir rides along — this proves `overseer init` delivers the
      // commit-docs script to every user with no extra install step.
      expect(
        existsSync(
          join(target, "overseer-to-prd", "scripts", "commit-docs.sh"),
        ),
      ).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
